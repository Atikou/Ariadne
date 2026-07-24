import type { ChatRequest, ModelClient, ModelResponse } from "../types.js";
import type { LocalModelDescriptor } from "./types.js";
import { LocalModelRuntimeManager } from "./LocalModelRuntimeManager.js";

export class EmbeddedModelClient implements ModelClient {
  readonly location = "local" as const;
  readonly name: string;
  readonly model: string;

  constructor(
    readonly descriptor: LocalModelDescriptor,
    private readonly runtimes: LocalModelRuntimeManager,
  ) {
    this.name = descriptor.id;
    this.model = descriptor.displayName;
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
