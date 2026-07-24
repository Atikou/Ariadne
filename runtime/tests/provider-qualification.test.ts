import { describe, expect, it } from "vitest";

import { ApiModelClientConfigSchema } from "../src/config/types.js";
import { buildModelProfiles } from "../src/model-router/model-profiles.js";

describe("Provider qualification matrix", () => {
  it("does not infer tool or streaming support from an OpenAI-compatible label", () => {
    const config = ApiModelClientConfigSchema.parse({
      kind: "api",
      name: "compatible",
      providerId: "vendor",
      protocol: "openai-compatible",
      location: "remote",
      baseUrl: "https://provider.example/v1",
      model: "model",
    });
    const [profile] = buildModelProfiles([config]);

    expect(config.qualification).toMatchObject({
      nativeTools: "unknown",
      textFallback: "unknown",
      streaming: "unknown",
      cancellation: "unknown",
      tokenizer: "unknown",
      errorBehavior: "unknown",
    });
    expect(profile).toMatchObject({
      supportsTools: false,
      supportsStreaming: false,
      supportsJsonMode: false,
    });
  });

  it("admits only capabilities explicitly recorded by qualification or model profile", () => {
    const qualified = ApiModelClientConfigSchema.parse({
      kind: "api",
      name: "qualified",
      providerId: "vendor",
      protocol: "openai-compatible",
      location: "remote",
      baseUrl: "https://provider.example/v1",
      model: "model",
      qualification: {
        nativeTools: "supported",
        textFallback: "unsupported",
        streaming: "supported",
        reasoning: "unknown",
        cancellation: "supported",
        tokenizer: "conservative",
        errorBehavior: "classified",
        evidence: "automated-adapter-fixture",
      },
    });

    expect(buildModelProfiles([qualified])[0]).toMatchObject({
      supportsTools: true,
      supportsStreaming: true,
    });
  });
});
