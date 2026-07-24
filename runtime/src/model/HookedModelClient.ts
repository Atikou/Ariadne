import { randomUUID } from "node:crypto";

import type { HookManager } from "../hooks/HookManager.js";
import { ProviderRequestError, classifyProviderError } from "./ProviderError.js";
import type { ChatRequest, ModelClient, ModelResponse } from "./types.js";

const MODEL_AUTHORITY_TIMEOUT_MS = 24 * 60 * 60_000;

/** Applies durable model lifecycle policy to every local and remote ModelClient. */
export class HookedModelClient implements ModelClient {
  readonly name: string;
  readonly location;
  readonly model: string;
  readonly toolCallCapability;
  readonly tokenCounter;
  readonly contextWindowTokens;

  constructor(
    private readonly inner: ModelClient,
    private readonly hooks: HookManager,
  ) {
    this.name = inner.name;
    this.location = inner.location;
    this.model = inner.model;
    this.toolCallCapability = inner.toolCallCapability;
    this.tokenCounter = inner.tokenCounter;
    this.contextWindowTokens = inner.contextWindowTokens;
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const eventId = randomUUID();
    const pre = await this.hooks.dispatch({
      event: "model.pre",
      eventId,
      payload: { client: this.name, model: this.model, location: this.location },
      authority: { permissions: [], timeoutMs: MODEL_AUTHORITY_TIMEOUT_MS },
    });
    if (!pre.allowed) {
      throw new ProviderRequestError("invalid_request", pre.reason ?? "model_hook_rejected");
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new ProviderRequestError("timeout", "model_hook_timeout")),
      pre.authority.timeoutMs,
    );
    timeout.unref?.();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.inner.chat({ ...request, signal });
      await this.dispatchPost(eventId, "success");
      return response;
    } catch (error) {
      const classified = classifyProviderError(error);
      await this.dispatchPost(eventId, "failure", classified.category);
      throw classified;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async dispatchPost(
    eventId: string,
    outcome: "success" | "failure",
    errorCategory?: string,
  ): Promise<void> {
    const post = await this.hooks.dispatch({
      event: "model.post",
      eventId,
      payload: {
        client: this.name,
        model: this.model,
        location: this.location,
        outcome,
        errorCategory,
      },
      authority: { permissions: [], timeoutMs: 5_000 },
    });
    if (!post.allowed) {
      throw new ProviderRequestError("invalid_request", post.reason ?? "model_post_hook_rejected");
    }
  }
}
