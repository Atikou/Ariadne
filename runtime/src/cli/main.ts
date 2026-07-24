/**
 * CLI 自检入口：加载配置并构建模型客户端，快速确认当前 profile 可用。
 * 子命令：`storage status` / `storage cleanup`
 */
import { loadConfig } from "../config/loadConfig.js";
import { createModelClients } from "../model/ModelFactory.js";
import { LocalModelService } from "../model/local/LocalModelService.js";
import { loadEnvFile } from "../util/env.js";

loadEnvFile();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "storage") {
    const { runStorageCli } = await import("./storage.js");
    await runStorageCli(args.slice(1));
    return;
  }

  const { profile, config, modelsDirectory } = loadConfig();
  const localModels = new LocalModelService({
    directory: modelsDirectory,
    autoDiscover: config.models.autoDiscover,
    watch: false,
    maxLoadedModels: config.models.maxLoadedModels,
    idleUnloadMs: config.models.idleUnloadMs,
    reservedClientNames: config.models.clients.map((client) => client.name),
  });
  const clients = [
    ...createModelClients(config.models.clients, { localRuntimes: localModels.runtimes }),
    ...localModels.clients(),
  ];

  console.log(`Agent 框架已就绪（profile=${profile}）。`);
  console.log(`已注册 ${clients.length} 个模型客户端：`);
  for (const client of clients) {
    console.log(`  - ${client.name}（${client.location} / ${client.model}）`);
  }
  console.log("\n已接入：模型路由、工具系统、计划/任务模式、Agent 循环、后台任务、子 Agent、上下文、审计与调度。");
  console.log("可先运行 `npm run models:check` 验证本地/远程模型连通性。");
  await localModels.stop();
}

main().catch((error) => {
  console.error("启动失败：", error);
  process.exitCode = 1;
});
