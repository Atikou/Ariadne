import type { ApiModelClientConfig, ModelClientConfig } from "../config/types.js";
import { AnthropicClient } from "./AnthropicClient.js";
import { OpenAICompatibleClient } from "./OpenAICompatibleClient.js";
import { EmbeddedModelClient } from "./local/EmbeddedModelClient.js";
import type { LocalModelRuntimeManager } from "./local/LocalModelRuntimeManager.js";
import { clientConfigToDescriptor } from "./local/types.js";
import type { ModelClient } from "./types.js";

export interface ModelFactoryDependencies {
  localRuntimes?: LocalModelRuntimeManager;
}

function resolveApiKey(config: ApiModelClientConfig): string | undefined {
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return undefined;
}

/** Creates either a remote API transport or an in-project embedded model client. */
export function createModelClient(
  config: ModelClientConfig,
  dependencies: ModelFactoryDependencies = {},
): ModelClient {
  if (config.kind === "embedded") {
    if (!dependencies.localRuntimes) {
      throw new Error(`创建嵌入式模型 ${config.name} 时缺少 LocalModelRuntimeManager`);
    }
    return new EmbeddedModelClient(clientConfigToDescriptor(config), dependencies.localRuntimes);
  }

  switch (config.protocol) {
    case "openai-compatible":
      return new OpenAICompatibleClient({
        name: config.name,
        providerId: config.providerId,
        model: config.model,
        location: "remote",
        baseUrl: config.baseUrl,
        apiKey: resolveApiKey(config),
        timeoutMs: config.timeoutMs,
      });
    case "anthropic-messages":
      return new AnthropicClient({
        name: config.name,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: resolveApiKey(config),
        apiVersion: config.apiVersion,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
  }
}

export function createModelClients(
  configs: ModelClientConfig[],
  dependencies: ModelFactoryDependencies = {},
): ModelClient[] {
  return configs.map((config) => createModelClient(config, dependencies));
}
