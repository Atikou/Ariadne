/**
 * 冒烟测试：加载配置 -> 创建本地/远程客户端 -> 探测可用性 -> 可选地对默认模型发一句话。
 *
 * 用法：
 *   npm run models:check
 *   AGENT_PROFILE=local-only npm run models:check
 *   npm run models:check -- --chat
 */
import { loadConfig } from "../config/loadConfig.js";
import { createModelClient } from "../model/ModelFactory.js";
import { LocalModelService } from "../model/local/LocalModelService.js";
import type { ModelClient } from "../model/types.js";
import { loadEnvFile } from "../util/env.js";

loadEnvFile();

async function main(): Promise<void> {
  const doChat = process.argv.includes("--chat");
  const { profile, config, workspaceRoot, modelsDirectory } = loadConfig();

  console.log(`Profile      : ${profile}`);
  console.log(`Workspace    : ${workspaceRoot}`);
  console.log(`路由策略     : ${config.routing.strategy}（fallback=${config.routing.fallback}）`);
  console.log(`默认模型     : ${config.models.default}`);
  console.log("");
  console.log("模型可用性探测：");

  const localModels = new LocalModelService({
    directory: modelsDirectory,
    autoDiscover: config.models.autoDiscover,
    watch: false,
    maxLoadedModels: config.models.maxLoadedModels,
    idleUnloadMs: config.models.idleUnloadMs,
    reservedClientNames: config.models.clients.map((client) => client.name),
  });
  const configured = config.models.clients.map((c) => ({
    config: c,
    client: createModelClient(c, { localRuntimes: localModels.runtimes }),
  }));
  const discovered = localModels.clients().map((client) => ({
    config: localModels.clientConfigs().find((config) => config.name === client.name)!,
    client,
  }));
  const clients = [...configured, ...discovered];

  const results = await Promise.all(
    clients.map(async ({ config: c, client }) => {
      const available = await client.isAvailable();
      return {
        name: c.name,
        location: c.location,
        provider: c.kind === "api" ? c.protocol : c.runtime,
        model: c.model,
        available,
      };
    }),
  );

  for (const r of results) {
    const flag = r.available ? "可用  " : "不可用";
    console.log(
      `  [${flag}] ${r.name.padEnd(16)} ${r.location.padEnd(6)} ${r.provider.padEnd(18)} ${r.model}`,
    );
  }

  if (!doChat) {
    console.log("\n（加 --chat 可对默认可用模型发送一条测试消息）");
    await localModels.stop();
    return;
  }

  const target = pickChatTarget(config.models.default, clients, results);
  if (!target) {
    console.log("\n没有可用模型，跳过 --chat 测试。");
    await localModels.stop();
    return;
  }

  console.log(`\n向 ${target.name} 发送测试消息...`);
  const response = await target.client.chat({
    messages: [
      { role: "system", content: "你是一个简洁的助手，只用一句话回答。" },
      { role: "user", content: "用一句话介绍你自己。" },
    ],
    temperature: 0.2,
  });

  console.log(`模型回复     : ${response.content}`);
  console.log(`实际模型     : ${response.modelName}（${response.location}）`);
  console.log(`耗时         : ${response.latencyMs.toFixed(0)}ms`);
  if (response.usage) {
    console.log(`token        : in=${response.usage.inputTokens ?? "?"} out=${response.usage.outputTokens ?? "?"}`);
  }
  await localModels.stop();
}

function pickChatTarget(
  defaultName: string,
  clients: Array<{ config: { name: string }; client: ModelClient }>,
  results: Array<{ name: string; available: boolean }>,
): { name: string; client: ModelClient } | undefined {
  const availableNames = new Set(results.filter((r) => r.available).map((r) => r.name));

  const preferred = clients.find(
    (c) => c.config.name === defaultName && availableNames.has(c.config.name),
  );
  if (preferred) return { name: preferred.config.name, client: preferred.client };

  const anyAvailable = clients.find((c) => availableNames.has(c.config.name));
  return anyAvailable ? { name: anyAvailable.config.name, client: anyAvailable.client } : undefined;
}

main().catch((error) => {
  console.error("models:check 失败：", error);
  process.exitCode = 1;
});
