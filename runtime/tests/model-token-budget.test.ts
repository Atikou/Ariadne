import { describe, expect, it } from "vitest";

import {
  createConservativeTokenCounter,
  conservativeTextTokens,
} from "../src/model/TokenCounter.js";
import { prepareChatRequestForModel } from "../src/model/prepareChatRequestForModel.js";
import type { ModelClient } from "../src/model/types.js";

function client(contextWindowTokens: number): ModelClient {
  return {
    name: "fixture",
    model: "fixture-model",
    location: "remote",
    contextWindowTokens,
    tokenCounter: createConservativeTokenCounter("fixture:conservative"),
    async isAvailable() { return true; },
    async chat() { throw new Error("not used"); },
  };
}

describe("model token budget", () => {
  it("marks conservative fallback counts as inexact", async () => {
    const counter = createConservativeTokenCounter("provider:model:conservative");
    const result = await counter.countText("中文 and English");
    expect(result.exact).toBe(false);
    expect(result.method).toBe("provider_profile_conservative");
    expect(result.tokens).toBe(conservativeTextTokens("中文 and English"));
  });

  it("reserves output and tool schema budget and never exceeds the context window", async () => {
    const model = client(180);
    const prepared = await prepareChatRequestForModel({
      maxTokens: 40,
      tools: [{
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }],
      messages: [
        { role: "system", content: "system policy" },
        { role: "assistant", content: "old oversized " + "x".repeat(500) },
        { role: "tool", content: "recent high value result" },
        { role: "user", content: "current request" },
      ],
    }, model);
    const final = await model.tokenCounter.countRequest(prepared.request);

    expect(final.tokens + prepared.outputReserve).toBeLessThanOrEqual(180);
    expect(prepared.request.messages.some((message) =>
      message.content.includes("old oversized"))).toBe(false);
    expect(prepared.request.messages.some((message) =>
      message.content.includes("recent high value"))).toBe(true);
    expect(prepared.toolSchemaTokens).toBeGreaterThan(0);
  });

  it("fails closed when essential messages cannot fit", async () => {
    await expect(prepareChatRequestForModel({
      maxTokens: 30,
      messages: [
        { role: "system", content: "x".repeat(500) },
        { role: "user", content: "request" },
      ],
    }, client(50))).rejects.toThrow("context_budget_exceeded:essential_messages");
  });
});
