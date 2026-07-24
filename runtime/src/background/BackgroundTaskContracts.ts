import { z } from "zod";

import { RunRecordSchema } from "../core/runTypes.js";
import {
  PermissionRequestPendingPayloadSchema,
} from "../policy/permissionRequestTypes.js";
import { StructuredToolRiskSchema } from "../policy/ToolRiskAssessment.js";
import {
  MAX_BACKGROUND_TASK_TIMEOUT_MS,
  MIN_BACKGROUND_TASK_TIMEOUT_MS,
} from "./constants.js";
import {
  BackgroundTriggerOnMatchSchema,
  OutputMatchResultSchema,
  OutputMatchRuleSchema,
} from "./outputTypes.js";

const identifier = z.string().trim().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });
const requestTimeout = z.number().int()
  .min(MIN_BACKGROUND_TASK_TIMEOUT_MS)
  .max(MAX_BACKGROUND_TASK_TIMEOUT_MS);
const recordedTimeout = z.number().int().positive().max(MAX_BACKGROUND_TASK_TIMEOUT_MS);

export const BackgroundTaskStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatusSchema>;

export const BackgroundStartOptionsSchema = z.object({
  cwd: identifier.optional(),
  networkAccess: z.boolean().optional(),
  timeoutMs: recordedTimeout.optional(),
  outputRules: z.array(OutputMatchRuleSchema).optional(),
  triggerOnMatch: BackgroundTriggerOnMatchSchema.optional(),
}).strict();
export type BackgroundStartOptions = z.infer<typeof BackgroundStartOptionsSchema>;

export const BackgroundStartInitialRequestSchema = z.object({
  command: z.string().trim().min(1),
  cwd: identifier.optional(),
  networkAccess: z.boolean().optional(),
  timeoutMs: requestTimeout.optional(),
  outputRules: z.array(OutputMatchRuleSchema).optional(),
  triggerOnMatch: BackgroundTriggerOnMatchSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (!request.triggerOnMatch || (request.outputRules?.length ?? 0) > 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "triggerOnMatch 需要至少一条 outputRules",
    path: ["triggerOnMatch"],
  });
});

export const BackgroundStartResumeRequestSchema = z.object({
  permissionRequestId: identifier,
}).strict();

export const BackgroundStartRequestSchema = z.union([
  BackgroundStartInitialRequestSchema,
  BackgroundStartResumeRequestSchema,
]);
export type BackgroundStartRequest = z.infer<typeof BackgroundStartRequestSchema>;

export const BackgroundTaskRecordSchema = z.object({
  id: identifier,
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  pid: z.number().int().positive().optional(),
  timeoutMs: recordedTimeout.optional(),
  networkAccess: z.boolean(),
  status: BackgroundTaskStatusSchema,
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable().optional(),
  startedAt: timestamp,
  endedAt: timestamp.optional(),
  error: z.string().optional(),
  outputRules: z.array(OutputMatchRuleSchema).optional(),
  outputMatches: z.array(OutputMatchResultSchema).optional(),
  triggerOnMatch: BackgroundTriggerOnMatchSchema.optional(),
  triggeredRunId: identifier.optional(),
  toolCallId: identifier.optional(),
  runId: identifier.optional(),
  sessionId: identifier.optional(),
}).strict();
export type BackgroundTaskRecord = z.infer<typeof BackgroundTaskRecordSchema>;

const suggestedToolActionSchema = z.object({
  tool: identifier,
  reason: z.string().min(1),
  input: z.record(z.unknown()).optional(),
}).strict();

export const BackgroundToolRunResultSchema = z.object({
  tool: identifier,
  durationMs: z.number().nonnegative(),
  toolCallId: identifier.optional(),
  executed: z.boolean(),
  outcomeClass: z.enum(["execution_error", "observation_failure", "observation_success"]),
  outcomeKind: identifier,
  message: z.string(),
  recoverable: z.boolean(),
  requiresUserAction: z.boolean().optional(),
  suggestedNextActions: z.array(suggestedToolActionSchema).optional(),
  outcomePath: z.string().optional(),
  outcomeCommand: z.string().optional(),
  outcomeExitCode: z.number().int().optional(),
  output: BackgroundTaskRecordSchema.optional(),
  ok: z.boolean(),
  code: z.enum(["unknown_tool", "invalid_input", "permission_denied", "timeout", "error"]).optional(),
  category: z.enum([
    "user_error",
    "environment_error",
    "permission_error",
    "temporary_error",
    "unknown_error",
  ]).optional(),
  risk: StructuredToolRiskSchema.optional(),
  error: z.string().optional(),
}).strict();

export const BackgroundToolLedgerSummarySchema = z.object({
  attemptedReadCalls: z.number().int().nonnegative(),
  blockedReadCalls: z.number().int().nonnegative(),
  successfulReadCalls: z.number().int().nonnegative(),
  attemptedShellCalls: z.number().int().nonnegative(),
  blockedShellCalls: z.number().int().nonnegative(),
  successfulShellCalls: z.number().int().nonnegative(),
  attemptedWriteCalls: z.number().int().nonnegative(),
  blockedWriteCalls: z.number().int().nonnegative(),
  successfulWriteCalls: z.number().int().nonnegative(),
  crossWorkspaceCalls: z.number().int().nonnegative(),
  successfulCrossWorkspaceCalls: z.number().int().nonnegative(),
  blockedCrossWorkspaceCalls: z.number().int().nonnegative(),
  rootsTouched: z.array(z.string()),
  sensitivePathCalls: z.number().int().nonnegative(),
}).strict();

export const BackgroundTaskListResultSchema = z.object({
  tasks: z.array(BackgroundTaskRecordSchema),
}).strict();

export const BackgroundTaskDetailResultSchema = z.object({
  task: BackgroundTaskRecordSchema,
}).strict();

export const BackgroundStartPendingResultSchema = z.object({
  needsConfirmation: z.literal(true),
  run: RunRecordSchema,
  permissionRequest: PermissionRequestPendingPayloadSchema,
  risk: StructuredToolRiskSchema,
}).strict().superRefine((result, ctx) => {
  if (
    result.run.id === result.permissionRequest.runId
    && result.run.kind === "background"
    && result.run.status === "waiting_confirmation"
  ) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "后台 Run 必须与 pending permissionRequest 身份和状态一致",
    path: ["run"],
  });
});

const backgroundStartExecutionResultSchema = z.object({
  runId: identifier,
  task: BackgroundTaskRecordSchema.optional(),
  toolResult: BackgroundToolRunResultSchema,
  executionMeta: z.object({
    toolLedgerSummary: BackgroundToolLedgerSummarySchema,
  }).strict(),
}).strict();

export const BackgroundStartSuccessResultSchema = backgroundStartExecutionResultSchema
  .superRefine((result, ctx) => {
    const valid = result.toolResult.executed
      && result.toolResult.ok
      && result.toolResult.outcomeClass === "observation_success"
      && result.task !== undefined
      && result.toolResult.output?.id === result.task.id
      && result.task.runId === result.runId;
    if (valid) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "成功响应必须绑定同一 Run、任务和成功工具结果",
    });
  });

export const BackgroundStartExecutionFailureResultSchema = backgroundStartExecutionResultSchema
  .superRefine((result, ctx) => {
    if (result.toolResult.ok && result.toolResult.executed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "失败响应不能包含成功执行的工具结果",
        path: ["toolResult"],
      });
    }
    const taskAndOutputMatch = result.task === undefined
      ? result.toolResult.output === undefined
      : result.toolResult.output?.id === result.task.id && result.task.runId === result.runId;
    if (taskAndOutputMatch) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "失败响应中的任务必须绑定同一 Run 和工具输出",
      path: ["task"],
    });
  });

export const BackgroundErrorResultSchema = z.object({
  error: z.string().min(1),
  code: identifier.optional(),
  blockReasonKind: z.enum(["workflow", "permission", "budget", "policy"]).optional(),
  risk: StructuredToolRiskSchema.optional(),
}).strict();

export const BackgroundStartConflictResultSchema = z.union([
  BackgroundErrorResultSchema,
  BackgroundStartExecutionFailureResultSchema,
]);
