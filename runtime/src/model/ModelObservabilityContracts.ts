import { z } from "zod";

import {
  EmbeddedModelRuntimeSchema,
  ModelLocationSchema,
  ModelProviderSchema,
} from "../config/types.js";

const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().trim().min(1).max(256);
const displayText = z.string().trim().min(1).max(1_024);
const publicText = z.string().max(4_096);
const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

export const MODEL_BACKENDS = [
  ...ModelProviderSchema.options,
  ...EmbeddedModelRuntimeSchema.options,
  "unknown",
] as const;

export const ModelBackendSchema = z.enum(MODEL_BACKENDS);

const modelCheckBase = {
  name: identifier,
  provider: ModelBackendSchema,
  location: ModelLocationSchema,
  model: displayText,
  checkedAt: timestamp,
};

export const ModelCheckItemSchema = z.discriminatedUnion("available", [
  z.object({
    ...modelCheckBase,
    available: z.literal(true),
  }).strict(),
  z.object({
    ...modelCheckBase,
    available: z.literal(false),
    reason: z.enum(["reported_unavailable", "probe_failed"]),
  }).strict(),
]);

export const ModelCheckResultSchema = z
  .array(ModelCheckItemSchema)
  .superRefine((items, context) => {
    if (new Set(items.map((item) => item.name)).size !== items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "模型探测结果中的 name 不得重复",
      });
    }
  });

export const PublicModelCatalogEntrySchema = z
  .object({
    id: identifier,
    displayName: displayText,
    format: z.enum(["gguf", "safetensors"]),
    runtime: EmbeddedModelRuntimeSchema,
    sizeBytes: nonNegativeInteger,
    modifiedAt: timestamp,
    status: z.enum(["ready", "unsupported", "incomplete", "invalid"]),
    error: publicText.optional(),
    contextSize: z.number().int().positive().optional(),
    gpuLayers: z.union([z.literal("auto"), nonNegativeInteger]).optional(),
    device: z.enum(["auto", "cpu", "cuda", "vulkan"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    firstTokenTimeoutMs: z.number().int().positive().optional(),
    tokenIdleTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.status === "ready" && entry.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "ready 模型不得携带错误",
      });
    }
    if (entry.status !== "ready" && !entry.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "不可用模型必须说明原因",
      });
    }
  });

export const LoadedLocalModelSchema = z
  .object({
    modelId: identifier,
    runtime: EmbeddedModelRuntimeSchema,
    lastUsedAt: timestamp,
  })
  .strict();

export const ModelCatalogResultSchema = z
  .object({
    directory: displayText,
    scannedAt: timestamp,
    models: z.array(PublicModelCatalogEntrySchema),
    errors: z.array(publicText),
    loaded: z.array(LoadedLocalModelSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.models.map((model) => model.id)).size !== result.models.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models"],
        message: "模型目录中的 id 不得重复",
      });
    }
    if (new Set(result.loaded.map((model) => model.modelId)).size !== result.loaded.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loaded"],
        message: "loaded 中的 modelId 不得重复",
      });
    }
    const catalog = new Map(result.models.map((model) => [model.id, model.runtime]));
    for (const [index, loaded] of result.loaded.entries()) {
      if (catalog.get(loaded.modelId) !== loaded.runtime) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["loaded", index, "modelId"],
          message: "loaded 必须引用目录中同运行时的模型",
        });
      }
    }
  });

export const ModelCallOutcomeSchema = z.enum([
  "completed",
  "cancelled",
  "timeout",
  "runtime_crash",
]);

export const PublicClientStatsSchema = z
  .object({
    clientName: identifier,
    location: ModelLocationSchema,
    calls: nonNegativeInteger,
    failures: nonNegativeInteger,
    cancellations: nonNegativeInteger,
    timeouts: nonNegativeInteger,
    runtimeCrashes: nonNegativeInteger,
    failureRate: z.number().finite().min(0).max(1),
    avgLatencyMs: nonNegativeInteger,
    totalInputTokens: nonNegativeInteger,
    totalOutputTokens: nonNegativeInteger,
    totalCostUsd: nonNegativeNumber,
  })
  .strict()
  .superRefine((stats, context) => {
    if (stats.failures + stats.cancellations > stats.calls) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calls"],
        message: "失败和取消次数不得超过总调用数",
      });
    }
    if (stats.timeouts + stats.runtimeCrashes !== stats.failures) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failures"],
        message: "失败次数必须等于超时与运行时崩溃之和",
      });
    }
    const denominator = stats.calls - stats.cancellations;
    const expectedRate = denominator === 0 ? 0 : stats.failures / denominator;
    if (Math.abs(stats.failureRate - expectedRate) > 1e-12) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureRate"],
        message: "failureRate 与调用计数不一致",
      });
    }
  });

export const PublicCallMetricSchema = z
  .object({
    clientName: identifier,
    model: displayText,
    location: ModelLocationSchema,
    success: z.boolean(),
    outcome: ModelCallOutcomeSchema,
    latencyMs: nonNegativeNumber,
    contextMessages: nonNegativeInteger,
    inputTokens: nonNegativeInteger.optional(),
    outputTokens: nonNegativeInteger.optional(),
    costUsd: nonNegativeNumber.optional(),
    strategy: identifier.optional(),
    taskType: identifier.optional(),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.success !== (metric.outcome === "completed")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["success"],
        message: "success 必须与 outcome 一致",
      });
    }
  });

export const ModelMetricsResultSchema = z
  .object({
    stats: z.array(PublicClientStatsSchema),
    recent: z.array(PublicCallMetricSchema).max(20),
    generatedAt: timestamp,
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.stats.map((item) => item.clientName)).size !== result.stats.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stats"],
        message: "客户端聚合指标不得重复",
      });
    }
  });

export const ModelObservabilityNoQuerySchema = z.object({}).strict();

export const ModelObservabilityQueryErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("MODEL_OBSERVABILITY_QUERY_INVALID"),
  })
  .strict();

export const ModelCheckErrorResultSchema = operationError("MODEL_CHECK_FAILED");
export const ModelCatalogErrorResultSchema = operationError("MODEL_CATALOG_FAILED");
export const ModelMetricsErrorResultSchema = operationError("MODEL_METRICS_FAILED");

function operationError<T extends string>(code: T) {
  return z.object({ error: z.string(), code: z.literal(code) }).strict();
}

export type ModelCheckItem = z.infer<typeof ModelCheckItemSchema>;
export type PublicModelCatalogEntry = z.infer<typeof PublicModelCatalogEntrySchema>;
export type ModelCatalogResult = z.infer<typeof ModelCatalogResultSchema>;
export type ModelMetricsResult = z.infer<typeof ModelMetricsResultSchema>;
