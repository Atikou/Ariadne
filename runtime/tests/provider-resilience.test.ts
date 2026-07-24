import { describe, expect, it, vi } from "vitest";

import type { ProviderResilienceConfig } from "../src/config/types.js";
import { ProviderRequestError } from "../src/model/ProviderError.js";
import { ResilientModelClient } from "../src/model/ProviderResilience.js";
import { createConservativeTokenCounter } from "../src/model/TokenCounter.js";
import type { ChatRequest, ModelClient, ModelResponse } from "../src/model/types.js";

const request: ChatRequest = {
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 16,
};

describe("Provider resilience policy", () => {
  it("honors Retry-After and retries only transient failures", async () => {
    const chat = vi.fn<ModelClient["chat"]>()
      .mockRejectedValueOnce(new ProviderRequestError("rate_limit", "limited", 429, 2_000))
      .mockResolvedValueOnce(response());
    const sleeps: number[] = [];
    const telemetry = { recordProviderCall: vi.fn() };
    const client = resilient(fakeClient(chat), policy(), {
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      random: () => 0,
      telemetry,
    });

    await expect(client.chat(request)).resolves.toMatchObject({ content: "ok" });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
    expect(telemetry.recordProviderCall).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      retryCount: 1,
    }));
  });

  it("never transparently retries after the first streamed token", async () => {
    const chat = vi.fn<ModelClient["chat"]>(async (input) => {
      input.onToken?.("partial");
      throw new ProviderRequestError("temporary", "connection reset", 503);
    });
    const onToken = vi.fn();
    const client = resilient(fakeClient(chat), policy(), {
      sleep: async () => undefined,
    });

    await expect(client.chat({ ...request, onToken })).rejects.toMatchObject({
      category: "temporary",
    });
    expect(onToken).toHaveBeenCalledWith("partial");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("opens and later probes a circuit per Provider/model", async () => {
    let now = 1_000;
    const chat = vi.fn<ModelClient["chat"]>()
      .mockRejectedValueOnce(new ProviderRequestError("temporary", "down"))
      .mockRejectedValueOnce(new ProviderRequestError("temporary", "down"))
      .mockResolvedValue(response());
    const client = resilient(fakeClient(chat), policy({
      maxAttempts: 1,
      circuitFailureThreshold: 2,
      circuitOpenMs: 5_000,
    }), {
      now: () => now,
      sleep: async () => undefined,
    });

    await expect(client.chat(request)).rejects.toThrow("down");
    await expect(client.chat(request)).rejects.toThrow("down");
    await expect(client.chat(request)).rejects.toThrow("provider_circuit_open");
    expect(chat).toHaveBeenCalledTimes(2);

    now += 5_001;
    await expect(client.chat(request)).resolves.toMatchObject({ content: "ok" });
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("enforces request limits before dispatching another Provider call", async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const chat = vi.fn<ModelClient["chat"]>().mockResolvedValue(response());
    const client = resilient(fakeClient(chat), policy({ requestsPerMinute: 1 }), {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await client.chat(request);
    await client.chat(request);
    expect(sleeps).toEqual([60_000]);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

function resilient(
  client: ModelClient,
  config: ProviderResilienceConfig,
  dependencies: ConstructorParameters<typeof ResilientModelClient>[3],
) {
  return new ResilientModelClient(client, "fixture", config, dependencies);
}

function fakeClient(chat: ModelClient["chat"]): ModelClient {
  return {
    name: "fixture",
    location: "remote",
    model: "fixture-model",
    tokenCounter: createConservativeTokenCounter("fixture"),
    async isAvailable() { return true; },
    chat,
  };
}

function response(): ModelResponse {
  return {
    content: "ok",
    toolCalls: [],
    clientName: "fixture",
    modelName: "fixture-model",
    location: "remote",
    latencyMs: 1,
  };
}

function policy(
  overrides: Partial<ProviderResilienceConfig> = {},
): ProviderResilienceConfig {
  return {
    maxAttempts: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    jitterRatio: 0,
    maxConcurrency: 2,
    requestsPerMinute: 100,
    tokensPerMinute: 1_000_000,
    circuitFailureThreshold: 3,
    circuitOpenMs: 30_000,
    ...overrides,
  };
}
