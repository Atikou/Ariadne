import { z } from "zod";

import {
  AgentErrorResultSchema,
  AgentExecutionResultSchema,
  AgentRunStateSchema,
} from "../agent/AgentPublicContracts.js";
import { JsonValueSchema } from "../core/jsonContracts.js";
import { RunRecordSchema } from "../core/runTypes.js";
import { PublicPlanJsonSchema } from "../plan/types.js";
import { TracePublicEventSchema, TraceTimelineEntrySchema } from "../trace/TraceContracts.js";

const identifier = z.string().trim().min(1).max(512);
const text = z.string();
const nonNegativeInteger = z.number().int().nonnegative();

export const RunNoQuerySchema = z.object({}).strict();
export const RunListQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .optional()
      .transform((value) => value ?? 50),
  })
  .strict();

export const RunCancelRequestSchema = z.object({ runId: identifier }).strict();

export const RunListResultSchema = z
  .object({ runs: z.array(RunRecordSchema), count: nonNegativeInteger })
  .strict()
  .superRefine((value, context) => {
    if (value.count === value.runs.length) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["count"],
      message: "count must equal runs.length",
    });
  });

export const RunningRunSchema = z
  .object({
    runId: identifier,
    kind: z.enum(["agent", "chat"]),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const RunsRunningResultSchema = z.object({ running: z.array(RunningRunSchema) }).strict();
export const RunCancelResultSchema = z
  .object({ runId: identifier, kind: z.enum(["agent", "chat"]), status: z.literal("cancelling") })
  .strict();
export const RunDetailResultSchema = z
  .object({ run: RunRecordSchema, runState: AgentRunStateSchema.optional() })
  .strict();

const RunReportUsageSchema = z
  .object({
    modelTurns: nonNegativeInteger,
    totalInputTokens: nonNegativeInteger,
    totalOutputTokens: nonNegativeInteger,
    totalCostUsd: z.number().finite().nonnegative(),
    toolCalls: nonNegativeInteger,
    toolFailures: nonNegativeInteger,
    toolObservationFailures: nonNegativeInteger,
    toolExecutionErrors: nonNegativeInteger,
  })
  .strict();

const RunReportSchema = z
  .object({
    runId: identifier,
    eventCount: nonNegativeInteger,
    events: z.array(TracePublicEventSchema),
    usage: RunReportUsageSchema,
    timeline: z.array(TraceTimelineEntrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.eventCount === value.events.length) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eventCount"],
      message: "eventCount must equal events.length",
    });
  });

export const RunReportResultSchema = z
  .object({ run: RunRecordSchema, report: RunReportSchema })
  .strict();
export const RunDeleteResultSchema = z
  .object({
    runId: identifier,
    deleted: z.literal(true),
    sessionId: identifier.optional(),
    artifactsBytesFreed: nonNegativeInteger,
    timelineDir: text.optional(),
    dataRunDir: text.optional(),
  })
  .strict();

export const RunQueryErrorResultSchema = z
  .object({ error: text, code: z.literal("RUN_QUERY_INVALID") })
  .strict();
export const RunRequestErrorResultSchema = z
  .object({ error: text, code: z.literal("invalid_request") })
  .strict();
export const RunReportErrorResultSchema = z
  .object({ error: text, code: z.literal("RUN_REPORT_FAILED") })
  .strict();
export const RunNotFoundResultSchema = z
  .object({ error: text, code: z.literal("RUN_NOT_FOUND"), runId: identifier })
  .strict();
export const RunTraceNotFoundResultSchema = z
  .object({ error: text, code: z.literal("RUN_TRACE_NOT_FOUND"), runId: identifier })
  .strict();
export const RunNotActiveResultSchema = z
  .object({ error: text, code: z.literal("RUN_NOT_ACTIVE"), runId: identifier })
  .strict();
export const RunActiveConflictResultSchema = z
  .object({ error: text, code: z.literal("RUN_ACTIVE"), runId: identifier })
  .strict();
export const RunApprovalNotFoundResultSchema = z
  .object({ error: text, code: z.literal("RUN_PERMISSION_REQUEST_NOT_FOUND"), runId: identifier })
  .strict();
export const RunBadRequestResultSchema = z.union([
  RunQueryErrorResultSchema,
  RunRequestErrorResultSchema,
]);

const LegacyPlanStepSchema = z
  .object({
    id: text,
    title: text,
    objective: text.optional(),
    description: text,
    requiredPermissions: z.array(z.enum(["read", "write", "shell", "network", "dangerous"])),
    needsConfirmation: z.boolean(),
    acceptance: text.optional(),
    dependsOn: z.array(text),
    requiredContext: z.array(text),
    availableTools: z.array(text),
    expectedArtifacts: z.array(text),
    priority: z.number().int(),
    tool: text.optional(),
    toolInput: z.record(JsonValueSchema).optional(),
    status: z.enum([
      "pending",
      "running",
      "waiting_agent",
      "blocked",
      "completed",
      "failed",
      "cancelled",
      "skipped",
    ]),
    result: text.optional(),
    error: text.optional(),
  })
  .strict();

const LegacyPlanSchema = z
  .object({
    goal: text,
    scope: z.object({ inScope: z.array(text), outOfScope: z.array(text) }).strict(),
    inputs: z.array(text),
    outputs: z.array(text),
    acceptanceCriteria: z.array(text),
    risks: z.array(text),
    dependencies: z.array(text),
    steps: z.array(LegacyPlanStepSchema),
  })
  .strict();

const TaskRollbackSchema = z
  .object({ attempted: nonNegativeInteger, restored: z.array(text), errors: z.array(text) })
  .strict();
const ModeFallbackSchema = z
  .object({
    triggered: z.literal(true),
    reasons: z.array(text),
    revisedPlan: LegacyPlanSchema.optional(),
    planId: identifier.optional(),
    version: z.number().int().positive().optional(),
    previewMarkdown: text.optional(),
    planRunId: identifier.optional(),
    error: text.optional(),
  })
  .strict();

export const PlanExecutionResultSchema = z
  .object({
    runId: identifier,
    taskId: identifier,
    planId: identifier,
    version: z.number().int().positive(),
    planRunId: identifier,
    executionMode: z.enum(["static", "agent_loop"]),
    plan: LegacyPlanSchema,
    rollback: TaskRollbackSchema.optional(),
    modeFallback: ModeFallbackSchema.optional(),
    resumedFromChildRunId: identifier.optional(),
  })
  .strict();

const PlanActivationCompiledResultSchema = z
  .object({
    phase: z.literal("compiled"),
    userVisiblePlanId: identifier,
    planId: identifier,
    version: z.number().int().positive(),
    status: text,
    executionMode: z.enum(["static", "agent_loop"]),
    dryRun: z.boolean(),
    autoApproved: z.literal(false),
    previewMarkdown: text,
    publicPlanJson: PublicPlanJsonSchema,
    warning: text,
  })
  .strict();

const PlanActivationExecutedResultSchema = z
  .object({
    phase: z.literal("executed"),
    userVisiblePlanId: identifier,
    planId: identifier,
    version: z.number().int().positive(),
    status: text,
    executionMode: z.enum(["static", "agent_loop"]),
    dryRun: z.boolean(),
    autoApproved: z.literal(true),
    execution: PlanExecutionResultSchema,
  })
  .strict();

export const AgentHttpSuccessResultSchema = z.union([
  AgentExecutionResultSchema,
  PlanExecutionResultSchema,
  PlanActivationCompiledResultSchema,
  PlanActivationExecutedResultSchema,
]);

export const AgentResumeSuccessResultSchema = AgentExecutionResultSchema;
export const AgentHttpErrorResultSchema = AgentErrorResultSchema;
