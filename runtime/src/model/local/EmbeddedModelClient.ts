import type { ChatRequest, ModelClient, ModelResponse, ModelToolSpec } from "../types.js";
import type { TokenCounter } from "../TokenCounter.js";
import type { LocalModelDescriptor } from "./types.js";
import { LocalModelRuntimeManager } from "./LocalModelRuntimeManager.js";

export class EmbeddedModelClient implements ModelClient {
  readonly location = "local" as const;
  readonly toolCallCapability = "unsupported" as const;
  readonly name: string;
  readonly model: string;
  readonly tokenCounter: TokenCounter;
  readonly contextWindowTokens: number | undefined;

  constructor(
    readonly descriptor: LocalModelDescriptor,
    private readonly runtimes: LocalModelRuntimeManager,
  ) {
    this.name = descriptor.id;
    this.model = descriptor.displayName;
    this.contextWindowTokens = descriptor.contextSize;
    this.tokenCounter = {
      profile: `${descriptor.runtime}:${descriptor.id}`,
      exact: true,
      countText: async (text) => this.runtimes.countTokens(this.descriptor, {
        messages: [{ role: "user", content: text }],
      }),
      countMessages: async (messages) => this.runtimes.countTokens(this.descriptor, {
        messages: [...messages],
      }),
      countTools: async (tools: readonly ModelToolSpec[]) => this.runtimes.countTokens(
        this.descriptor,
        { messages: [], tools: [...tools] },
      ),
      countRequest: async (request) => this.runtimes.countTokens(this.descriptor, {
        messages: [...request.messages],
        tools: request.tools ? [...request.tools] : undefined,
      }),
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.descriptor.status === "ready" && this.runtimes.isAvailable(this.descriptor.runtime);
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    if (this.descriptor.status !== "ready") {
      throw new Error(this.descriptor.error ?? `模型 ${this.name} 尚未准备好`);
    }
    return this.runtimes.generate(this.descriptor, request);
  }
}
