import { z } from "zod";

import { ModelLocationSchema } from "../config/types.js";
import { PublicClientStatsSchema } from "../model/ModelObservabilityContracts.js";
import {
  EXECUTION_STRATEGY_VALUES,
  MODEL_LEVEL_VALUES,
  TASK_TYPE_VALUES,
} from "./types.js";

const identifier = z.string().trim().min(1).max(512);
const shortText = z.string().max(1_024);
const publicText = z.string().max(8_192);
const timestamp = z.string().datetime({ offset: true });
const nonNegativeInteger = z.number().int().nonnegative();
const rate = z.number().finite().min(0).max(1);
const modelLevel = z.union([
  z.literal(MODEL_LEVEL_VALUES[0]),
  z.literal(MODEL_LEVEL_VALUES[1]),
  z.literal(MODEL_LEVEL_VALUES[2]),
  z.literal(MODEL_LEVEL_VALUES[3]),
]);
const taskType = z.enum(TASK_TYPE_VALUES);
const executionStrategy = z.enum(EXECUTION_STRATEGY_VALUES);
const modelRole = z.enum(["primary", "draft", "review", "final"]);
const riskLevel = z.enum(["low", "medium", "high"]);
const routingSource = z.enum([
  "rule",
  "manual_override",
  "fallback",
  "evaluator",
  "runtime_stats",
  "cost_budget",
]);
const fallbackTrigger = z.enum([
  "model_timeout",
  "model_error",
  "empty_output",
  "json_parse_failed",
  "review_rejected",
  "review_failed",
  "answer_too_short",
]);

function positiveIntegerText(maximum: number) {
  return z
    .string()
    .regex(/^[1-9]\d*$/, "必须为正整数")
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value <= maximum, `不得超过 ${maximum}`);
}

export const RoutingLogsQuerySchema = z
  .object({
    routeLogId: identifier.optional(),
    sessionId: identifier.optional(),
    limit: positiveIntegerText(100).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.routeLogId && (query.sessionId || query.limit != null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "routeLogId 详情查询不能同时提供 sessionId 或 limit",
      });
    }
  })
  .transform((query) => ({ ...query, limit: query.limit ?? 20 }));

export const RoutingProfilesQuerySchema = z.object({}).strict();

export const RoutingStatsQuerySchema = z
  .object({ limit: positiveIntegerText(1_000).optional() })
  .strict()
  .transform((query) => ({ limit: query.limit ?? 200 }));

export const RoutingRouteLogSchema = z
  .object({
    id: identifier,
    sessionId: identifier.optional(),
    projectId: identifier.optional(),
    userInputPreview: publicText,
    taskType,
    selectedLevel: modelLevel,
    executionStrategy,
    selectedModelId: identifier.optional(),
    draftModelId: identifier.optional(),
    reviewModelId: identifier.optional(),
    finalModelId: identifier.optional(),
    risk: riskLevel,
    reason: publicText,
    source: routingSource,
    candidates: z.array(identifier).max(100),
    requireUserConfirmation: z.boolean(),
    fallbackNote: publicText.optional(),
    createdAt: timestamp,
  })
  .strict();

export const RoutingModelCallLogSchema = z
  .object({
    id: identifier,
    routeLogId: identifier.optional(),
    collaborationRunId: identifier.optional(),
    sessionId: identifier.optional(),
    modelId: identifier,
    role: modelRole,
    inputPreview: publicText.optional(),
    outputPreview: publicText.optional(),
    status: z.enum(["ok", "error"]),
    errorMessage: publicText.optional(),
    promptTokens: nonNegativeInteger.optional(),
    completionTokens: nonNegativeInteger.optional(),
    durationMs: nonNegativeInteger.optional(),
    createdAt: timestamp,
  })
  .strict();

export const RoutingCollaborationIssueSchema = z
  .object({
    severity: riskLevel,
    message: publicText,
  })
  .strict();

export const RoutingCollaborationLogSchema = z
  .object({
    id: identifier,
    sessionId: identifier.optional(),
    projectId: identifier.optional(),
    routeLogId: identifier.optional(),
    strategy: executionStrategy,
    draftModelId: identifier.optional(),
    reviewModelId: identifier.optional(),
    finalModelId: identifier.optional(),
    verdict: z.enum(["approve", "revise", "reject"]).optional(),
    confidence: rate.optional(),
    issues: z.array(RoutingCollaborationIssueSchema).max(100).optional(),
    status: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const RoutingFallbackLogSchema = z
  .object({
    id: identifier,
    routeLogId: identifier,
    sessionId: identifier.optional(),
    fromModelId: identifier,
    toModelId: identifier,
    fromStrategy: executionStrategy,
    toStrategy: executionStrategy,
    triggerType: fallbackTrigger,
    reason: publicText,
    createdAt: timestamp,
  })
  .strict();

const graphMetaValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const RoutingPipelineGraphSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: identifier,
          kind: z.enum([
            "entry",
            "rule",
            "decision",
            "strategy",
            "model",
            "collaboration",
            "fallback",
          ]),
          label: shortText,
          meta: z.record(z.string(), graphMetaValue).optional(),
        })
        .strict(),
    ),
    edges: z.array(
      z
        .object({
          from: identifier,
          to: identifier,
          label: shortText.optional(),
        })
        .strict(),
    ),
    mermaid: publicText,
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (nodeIds.size !== graph.nodes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "节点 id 不得重复" });
    }
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "边必须引用已存在的节点",
        });
      }
    }
  });

export const RoutingLogListResultSchema = z
  .object({
    routes: z.array(RoutingRouteLogSchema),
    count: nonNegativeInteger,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.count !== result.routes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "count 必须等于 routes.length" });
    }
  });

export const RoutingLogDetailResultSchema = z
  .object({
    route: RoutingRouteLogSchema,
    calls: z.array(RoutingModelCallLogSchema),
    collaborations: z.array(RoutingCollaborationLogSchema),
    fallbacks: z.array(RoutingFallbackLogSchema),
    pipelineGraph: RoutingPipelineGraphSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const routeId = result.route.id;
    for (const [field, rows] of [
      ["calls", result.calls],
      ["collaborations", result.collaborations],
      ["fallbacks", result.fallbacks],
    ] as const) {
      rows.forEach((row, index) => {
        if (row.routeLogId != null && row.routeLogId !== routeId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, "routeLogId"],
            message: "关联记录必须属于当前路由",
          });
        }
      });
    }
  });

export const RoutingLogResultSchema = z.union([
  RoutingLogListResultSchema,
  RoutingLogDetailResultSchema,
]);

const declaredCapabilitiesShape = {
  text: z.boolean(),
  image: z.boolean(),
  audio: z.boolean(),
  video: z.boolean(),
  file: z.boolean(),
  code: z.boolean(),
  architecture: z.boolean(),
  toolCalling: z.boolean(),
  jsonMode: z.boolean(),
  longContext: z.boolean(),
  ocr: z.boolean(),
  uiScreenshot: z.boolean(),
  chartUnderstanding: z.boolean(),
  diagramUnderstanding: z.boolean(),
  spatialReasoning: z.boolean(),
  imageGeneration: z.boolean(),
  imageEditing: z.boolean(),
};

export const RoutingDeclaredCapabilitiesSchema = z.object(declaredCapabilitiesShape).strict();

export const RoutingModelProfileSchema = z
  .object({
    id: identifier,
    displayName: shortText,
    provider: z.enum(["local", "api", "mock"]),
    defaultLevel: modelLevel,
    enabled: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsTools: z.boolean(),
    supportsVision: z.boolean(),
    supportsJsonMode: z.boolean(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    relativeCost: z.enum(["free", "low", "medium", "high"]),
    avgLatencyMs: nonNegativeInteger.optional(),
    allowedTaskTypes: z.array(taskType),
    allowedRoles: z.array(modelRole),
    canDraft: z.boolean(),
    canReview: z.boolean(),
    canFinal: z.boolean(),
    tags: z.array(identifier).optional(),
    declaredCapabilities: RoutingDeclaredCapabilitiesSchema,
    privacy: z
      .object({ local: z.boolean(), remote: z.boolean(), allowSensitive: z.boolean() })
      .strict(),
    capabilities: z
      .object({
        supportsStreaming: z.boolean(),
        supportsTools: z.boolean(),
        supportsVision: z.boolean(),
        supportsJsonMode: z.boolean(),
        maxInputTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
        defaultLevel: modelLevel,
      })
      .strict(),
  })
  .strict();

export const RoutingTaskCapabilityRequirementSchema = z
  .object({
    taskType,
    minLevel: modelLevel,
    supportsVision: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsJsonMode: z.boolean().optional(),
    minInputTokens: z.number().int().positive().optional(),
    description: shortText,
  })
  .strict();

export const RoutingTaskCoverageSchema = z
  .object({
    taskType,
    minLevel: modelLevel,
    supportsVision: z.boolean(),
    supportsTools: z.boolean(),
    supportsJsonMode: z.boolean(),
    primaryCandidates: z.array(identifier),
    draftCandidates: z.array(identifier),
    reviewCandidates: z.array(identifier),
    uncovered: z.boolean(),
  })
  .strict();

export const RoutingModelRuntimeHintSchema = z
  .object({
    calls: nonNegativeInteger,
    errors: nonNegativeInteger,
    errorRate: rate,
    fallbackFromCount: nonNegativeInteger,
    fallbackToCount: nonNegativeInteger,
  })
  .strict()
  .superRefine((hint, context) => {
    const expected = hint.calls === 0 ? 0 : hint.errors / hint.calls;
    if (hint.errors > hint.calls || Math.abs(hint.errorRate - expected) > 1e-12) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorRate"], message: "错误率与计数不一致" });
    }
  });

export const RoutingModelAvailabilitySchema = z
  .object({
    modelId: identifier,
    available: z.boolean(),
    checkedAt: timestamp,
    reason: publicText.optional(),
    unavailableUntil: timestamp.optional(),
  })
  .strict();

export const RoutingAgentProtocolQualificationSchema = z
  .object({
    modelId: identifier,
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    protocolVersion: z.number().int().positive(),
    status: z.enum(["unknown", "probation", "qualified", "quarantined"]),
    successCount: nonNegativeInteger,
    failureCount: nonNegativeInteger,
    consecutiveFailures: nonNegativeInteger,
    lastCheckedAt: timestamp.optional(),
    qualifiedAt: timestamp.optional(),
    quarantinedAt: timestamp.optional(),
    quarantineUntil: timestamp.optional(),
    reason: publicText.optional(),
  })
  .strict();

export const RoutingProfilesResultSchema = z
  .object({
    profiles: z.array(RoutingModelProfileSchema),
    matrix: z.array(RoutingTaskCapabilityRequirementSchema),
    coverage: z.array(RoutingTaskCoverageSchema),
    validationWarnings: z.array(publicText),
    generatedAt: timestamp,
    enabledCount: nonNegativeInteger,
    validationErrors: z.array(publicText),
    runtimeHintsByModelId: z.record(identifier, RoutingModelRuntimeHintSchema),
    availability: z.array(RoutingModelAvailabilitySchema).optional(),
    agentProtocolQualifications: z.array(RoutingAgentProtocolQualificationSchema).optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const enabled = snapshot.profiles.filter((profile) => profile.enabled).length;
    if (snapshot.enabledCount !== enabled) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledCount"], message: "enabledCount 与 profiles 不一致" });
    }
  });

export const RoutingModelRuntimeMetricSchema = z
  .object({
    modelId: identifier,
    calls: nonNegativeInteger,
    errors: nonNegativeInteger,
    errorRate: rate,
    avgDurationMs: nonNegativeInteger,
    totalPromptTokens: nonNegativeInteger,
    totalCompletionTokens: nonNegativeInteger,
    fallbackFromCount: nonNegativeInteger,
    fallbackToCount: nonNegativeInteger,
  })
  .strict()
  .superRefine((metric, context) => {
    const expected = metric.calls === 0 ? 0 : metric.errors / metric.calls;
    if (metric.errors > metric.calls || Math.abs(metric.errorRate - expected) > 1e-12) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorRate"], message: "错误率与计数不一致" });
    }
  });

export const RoutingTaskRuntimeMetricSchema = z
  .object({
    taskType,
    routes: nonNegativeInteger,
    routesWithFallback: nonNegativeInteger,
    fallbackRate: rate,
    evaluatorRoutes: nonNegativeInteger,
    topStrategy: executionStrategy,
  })
  .strict()
  .superRefine((metric, context) => {
    const expected = metric.routes === 0 ? 0 : metric.routesWithFallback / metric.routes;
    if (
      metric.routesWithFallback > metric.routes ||
      metric.evaluatorRoutes > metric.routes ||
      Math.abs(metric.fallbackRate - expected) > 1e-12
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fallbackRate"], message: "任务统计计数不一致" });
    }
  });

export const RoutingStatsSuggestionSchema = z
  .object({
    id: identifier,
    severity: z.enum(["info", "warn"]),
    category: z.enum([
      "model_reliability",
      "fallback_pattern",
      "routing_source",
      "process_metrics",
    ]),
    message: publicText,
    evidence: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  })
  .strict();

export const RoutingStatsResultSchema = z
  .object({
    generatedAt: timestamp,
    window: z.object({ routeLimit: z.number().int().min(1).max(1_000) }).strict(),
    summary: z
      .object({
        routeCount: nonNegativeInteger,
        routesWithFallback: nonNegativeInteger,
        fallbackRate: rate,
        evaluatorOverrides: nonNegativeInteger,
        ruleOnlyRoutes: nonNegativeInteger,
      })
      .strict(),
    models: z.array(RoutingModelRuntimeMetricSchema),
    taskTypes: z.array(RoutingTaskRuntimeMetricSchema),
    processMetrics: z.array(PublicClientStatsSchema),
    suggestions: z.array(RoutingStatsSuggestionSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const summary = snapshot.summary;
    const expected = summary.routeCount === 0 ? 0 : summary.routesWithFallback / summary.routeCount;
    if (
      summary.routeCount > snapshot.window.routeLimit ||
      summary.routesWithFallback > summary.routeCount ||
      summary.evaluatorOverrides > summary.routeCount ||
      summary.ruleOnlyRoutes > summary.routeCount ||
      Math.abs(summary.fallbackRate - expected) > 1e-12
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "路由汇总计数不一致" });
    }
  });

export const RoutingQueryErrorResultSchema = operationError("ROUTING_QUERY_INVALID");
export const RoutingLogReadErrorResultSchema = operationError("ROUTING_LOG_READ_FAILED");
export const RoutingProfilesReadErrorResultSchema = operationError("ROUTING_PROFILES_READ_FAILED");
export const RoutingStatsReadErrorResultSchema = operationError("ROUTING_STATS_READ_FAILED");

export const RoutingLogNotFoundResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("ROUTING_LOG_NOT_FOUND"),
    routeLogId: identifier,
  })
  .strict();

function operationError<T extends string>(code: T) {
  return z.object({ error: z.string(), code: z.literal(code) }).strict();
}

export type RoutingLogsQuery = z.output<typeof RoutingLogsQuerySchema>;
export type RoutingStatsQuery = z.output<typeof RoutingStatsQuerySchema>;
export type RoutingCollaborationLog = z.infer<typeof RoutingCollaborationLogSchema>;
