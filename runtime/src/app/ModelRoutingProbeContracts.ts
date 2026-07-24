import { z } from "zod";

import { MODEL_TASK_TYPES } from "../model/taskType.js";
import {
  EXECUTION_STRATEGY_VALUES,
  TASK_TYPE_VALUES,
} from "../model-router/types.js";

const nonEmptyString = z.string().trim().min(1);

export const ModelRoutingProbeRequestSchema = z.object({
  message: nonEmptyString.max(32_000),
  system: z.string().trim().max(32_000).optional(),
  clientName: nonEmptyString.optional(),
  sensitive: z.boolean().optional(),
  taskType: z.enum(MODEL_TASK_TYPES).optional(),
  qualityMode: z.enum(["fast", "balanced", "deep"]).optional(),
  allowCollaboration: z.boolean().optional(),
  forceSingleModel: z.boolean().optional(),
  maxCostUsd: z.number().finite().nonnegative().optional(),
  spentCostUsd: z.number().finite().nonnegative().optional(),
  streamTokens: z.boolean().optional(),
}).strict();
export type ModelRoutingProbeRequest = z.infer<typeof ModelRoutingProbeRequestSchema>;

const ModelTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
}).strict();

const ModelRoutingProbeModelSchema = z.object({
  clientName: nonEmptyString,
  modelName: nonEmptyString,
  location: z.enum(["local", "remote"]),
  latencyMs: z.number().int().nonnegative(),
  usage: ModelTokenUsageSchema.optional(),
}).strict();

const ModelRoutingProbeDecisionSchema = z.object({
  id: nonEmptyString,
  taskType: z.enum(TASK_TYPE_VALUES),
  executionStrategy: z.enum(EXECUTION_STRATEGY_VALUES),
  risk: z.enum(["low", "medium", "high"]),
  reason: nonEmptyString,
  source: z.enum([
    "rule",
    "manual_override",
    "fallback",
    "evaluator",
    "runtime_stats",
    "cost_budget",
  ]),
  requiresSafetyReview: z.boolean(),
  selectedModelId: nonEmptyString.optional(),
  draftModelId: nonEmptyString.optional(),
  reviewModelId: nonEmptyString.optional(),
  finalModelId: nonEmptyString.optional(),
  voteModelIds: z.array(nonEmptyString).max(8).optional(),
  judgeModelId: nonEmptyString.optional(),
  contextSignals: z.array(nonEmptyString).max(50).optional(),
  promptStrategy: z.object({
    temperature: z.number().finite(),
    responseStyle: z.enum(["concise", "balanced", "detailed"]),
    preferJsonMode: z.boolean(),
    hints: z.array(nonEmptyString).max(100),
  }).strict(),
}).strict();

const ModelRoutingProbeRoutingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("smart"),
    decision: ModelRoutingProbeDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("forced_client"),
    requestedClientName: nonEmptyString,
  }).strict(),
]);

const ModelRoutingProbeVoteSchema = z.object({
  winnerModelId: nonEmptyString,
  candidateModelIds: z.array(nonEmptyString).min(1).max(8),
  reason: nonEmptyString.optional(),
}).strict();

const ModelRoutingProbeExecutionSchema = z.object({
  usedModelIds: z.array(nonEmptyString).max(16),
  modelCallIds: z.array(nonEmptyString).max(32),
  collaborationRunId: nonEmptyString.optional(),
  fallbackCount: z.number().int().positive().optional(),
  fallbackLogIds: z.array(nonEmptyString).max(16).optional(),
  vote: ModelRoutingProbeVoteSchema.optional(),
}).strict();

export const ModelRoutingProbeResultSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.literal("model_routing_probe"),
  content: z.string(),
  routing: ModelRoutingProbeRoutingSchema,
  model: ModelRoutingProbeModelSchema.nullable(),
  execution: ModelRoutingProbeExecutionSchema,
}).strict();
export type ModelRoutingProbeResult = z.infer<typeof ModelRoutingProbeResultSchema>;

export const ModelRoutingProbeInvalidRequestSchema = z.object({
  error: nonEmptyString,
  code: z.literal("invalid_request"),
}).strict();

export const ModelRoutingProbeClientNotFoundSchema = z.object({
  error: nonEmptyString,
  code: z.literal("MODEL_CLIENT_NOT_FOUND"),
  clientName: nonEmptyString,
}).strict();

export const MODEL_ROUTING_PROBE_ROUTER_ERROR_CODES = [
  "NO_AVAILABLE_MODEL",
  "NO_REVIEW_MODEL_AVAILABLE",
  "RULE_ONLY_NOT_IMPLEMENTED",
  "MODEL_CAPABILITY_MISMATCH",
  "MODEL_PROTOCOL_QUARANTINED",
] as const;

export const ModelRoutingProbeRouterErrorSchema = z.object({
  error: nonEmptyString,
  code: z.enum(MODEL_ROUTING_PROBE_ROUTER_ERROR_CODES),
}).strict();

export const ModelRoutingProbeUpstreamErrorSchema = z.object({
  error: nonEmptyString,
  code: z.literal("MODEL_ROUTING_PROBE_FAILED"),
}).strict();

const ModelRoutingProbeStartEventSchema = z.object({
  type: z.literal("probe_start"),
  requestId: z.string().uuid(),
}).strict();

const ModelRoutingProbeTokenEventSchema = z.object({
  type: z.literal("token"),
  requestId: z.string().uuid(),
  delta: z.string().min(1),
}).strict();

const ModelRoutingProbeDoneEventSchema = z.object({
  type: z.literal("done"),
  requestId: z.string().uuid(),
  result: ModelRoutingProbeResultSchema,
}).strict().superRefine((event, ctx) => {
  if (event.requestId === event.result.requestId) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "done 事件必须绑定同一个 requestId",
    path: ["result", "requestId"],
  });
});

const ModelRoutingProbeErrorEventSchema = z.object({
  type: z.literal("error"),
  requestId: z.string().uuid(),
  error: nonEmptyString,
  code: z.union([
    z.enum(MODEL_ROUTING_PROBE_ROUTER_ERROR_CODES),
    z.literal("MODEL_ROUTING_PROBE_FAILED"),
    z.literal("CANCELLED"),
  ]),
}).strict();

export const ModelRoutingProbeStreamEventSchema = z.union([
  ModelRoutingProbeStartEventSchema,
  ModelRoutingProbeTokenEventSchema,
  ModelRoutingProbeDoneEventSchema,
  ModelRoutingProbeErrorEventSchema,
]);
export type ModelRoutingProbeStreamEvent = z.infer<typeof ModelRoutingProbeStreamEventSchema>;
