import { describe, expect, it } from "vitest";

import { TelemetryConfigSchema } from "../src/config/types.js";
import { sanitizeTelemetryAttributes } from "../src/telemetry/TelemetryService.js";

describe("OpenTelemetry export policy", () => {
  it("is disabled by default and requires exact HTTPS allowlist matches", () => {
    expect(TelemetryConfigSchema.parse({})).toMatchObject({ enabled: false });
    expect(TelemetryConfigSchema.safeParse({
      enabled: true,
      traceEndpoint: "http://collector.example/v1/traces",
      metricEndpoint: "https://collector.example/v1/metrics",
      allowedEndpoints: ["https://collector.example/v1/metrics"],
    }).success).toBe(false);
    expect(TelemetryConfigSchema.safeParse({
      enabled: true,
      traceEndpoint: "https://collector.example/v1/traces",
      metricEndpoint: "https://collector.example/v1/metrics",
      allowedEndpoints: ["https://collector.example/v1/traces"],
    }).success).toBe(false);
    expect(TelemetryConfigSchema.safeParse({
      enabled: true,
      traceEndpoint: "https://collector.example/v1/traces",
      metricEndpoint: "https://collector.example/v1/metrics",
      allowedEndpoints: [
        "https://collector.example/v1/traces",
        "https://collector.example/v1/metrics",
      ],
    }).success).toBe(true);
  });

  it("drops user content, arbitrary keys and filesystem paths", () => {
    const attributes = sanitizeTelemetryAttributes({
      "provider.id": "openai",
      "model.id": "model",
      outcome: "success",
      prompt: "private prompt",
      content: "secret",
      path: "E:\\Project\\Ariadne\\secret.txt",
      operation: "E:\\Project\\Ariadne\\secret.txt",
      "retry.count": 1,
    });

    expect(attributes).toEqual({
      "provider.id": "openai",
      "model.id": "model",
      outcome: "success",
      "retry.count": 1,
    });
    expect(JSON.stringify(attributes)).not.toMatch(/private|secret|Ariadne/iu);
  });
});
