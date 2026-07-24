import {
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import type { TelemetryConfig } from "../config/types.js";

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "provider.id",
  "model.id",
  "operation",
  "outcome",
  "error.category",
  "retry.count",
  "status.code",
]);

export interface ProviderTelemetryRecord {
  providerId: string;
  model: string;
  outcome: "success" | "failure";
  durationMs: number;
  retryCount: number;
  errorCategory?: string;
  statusCode?: number;
}

/**
 * Stable traces/metrics only. No logs, prompt text, tool output, filesystem path
 * or arbitrary attributes can enter the exporter.
 */
export class TelemetryService {
  private readonly traceProvider?: NodeTracerProvider;
  private readonly meterProvider?: MeterProvider;
  private readonly tracer?: Tracer;
  private readonly requestCounter?: Counter;
  private readonly durationHistogram?: Histogram;

  constructor(config: TelemetryConfig, serviceVersion: string) {
    if (!config.enabled) return;
    assertTelemetryEndpoint(config.traceEndpoint!, config.allowedEndpoints);
    assertTelemetryEndpoint(config.metricEndpoint!, config.allowedEndpoints);
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "ariadne-runtime",
      [ATTR_SERVICE_VERSION]: serviceVersion,
    });
    this.traceProvider = new NodeTracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.sampleRatio),
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: config.traceEndpoint })),
      ],
    });
    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: config.metricEndpoint }),
          exportIntervalMillis: config.exportIntervalMs,
        }),
      ],
    });
    this.tracer = this.traceProvider.getTracer("ariadne-runtime", serviceVersion);
    const meter = this.meterProvider.getMeter("ariadne-runtime", serviceVersion);
    this.requestCounter = meter.createCounter("ariadne.provider.requests");
    this.durationHistogram = meter.createHistogram("ariadne.provider.duration", {
      unit: "ms",
    });
  }

  recordProviderCall(record: ProviderTelemetryRecord): void {
    if (!this.tracer || !this.requestCounter || !this.durationHistogram) return;
    const attributes = sanitizeTelemetryAttributes({
      "provider.id": record.providerId,
      "model.id": record.model,
      operation: "chat",
      outcome: record.outcome,
      "retry.count": record.retryCount,
      ...(record.errorCategory ? { "error.category": record.errorCategory } : {}),
      ...(record.statusCode !== undefined ? { "status.code": record.statusCode } : {}),
    });
    const span = this.tracer.startSpan("provider.chat", { attributes });
    span.setStatus({
      code: record.outcome === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    span.end();
    this.requestCounter.add(1, attributes);
    this.durationHistogram.record(Math.max(0, record.durationMs), attributes);
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.traceProvider?.shutdown(),
      this.meterProvider?.shutdown(),
    ]);
  }
}

export function sanitizeTelemetryAttributes(
  values: Record<string, unknown>,
): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
    if (
      typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) continue;
    const rendered = String(value);
    if (
      rendered.length > 256
      || /[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp)\//u.test(rendered)
      || /(?:prompt|content|message|secret|token|api[_-]?key)/iu.test(key)
    ) continue;
    attributes[key] = value;
  }
  return attributes;
}

function assertTelemetryEndpoint(endpoint: string, allowed: readonly string[]): void {
  const normalized = new URL(endpoint).toString();
  if (!allowed.some((candidate) => new URL(candidate).toString() === normalized)) {
    throw new Error(`telemetry_endpoint_not_allowlisted:${new URL(endpoint).origin}`);
  }
}
