import { describe, expect, it } from "vitest";

import {
  createConservativeTokenCounter,
  conservativeTextTokens,
} from "../src/model/TokenCounter.js";

describe("model token budget", () => {
  it("marks conservative fallback counts as inexact", async () => {
    const counter = createConservativeTokenCounter("provider:model:conservative");
    const result = await counter.countText("中文 and English");
    expect(result.exact).toBe(false);
    expect(result.method).toBe("provider_profile_conservative");
    expect(result.tokens).toBe(conservativeTextTokens("中文 and English"));
  });

});
