import { z } from "zod";

import { agentRunBudgetBodySchema } from "../orchestrator/AgentRequestSchemas.js";
import { UserVisiblePlanSchema } from "./types.js";

const nonBlankString = z.string().trim().min(1);
const nonNegativeInteger = z.number().int().nonnegative();

export const AgentStopReasonSchema = z.enum([
  "completed",
  "completed_partial",
  "recovery_partial",
  "misleading_completion",
  "blocked_by_policy",
  "budget_exhausted",
  "historical_reference",
  "error",
  "user_cancelled",
  "awaiting_permission",
  "awaiting_plan_handoff",
]);

export const PlanReportIncompleteStopReasonSchema = AgentStopReasonSchema.exclude(["completed"]);

export const PlanReportUserFacingStateSchema = z.enum([
  "answering",
  "analyzing",
  "planning",
  "waiting_plan_approval",
  "editing",
  "debugging",
  "waiting_tool_permission",
  "verifying",
  "write_gate_blocked",
  "completed",
  "completed_partial",
  "failed",
  "cancelled",
]);

export const PlanReportRequestSchema = z
  .object({
    goal: nonBlankString,
    context: z.string().optional(),
    sessionId: nonBlankString.optional(),
    clientName: nonBlankString.optional(),
    budget: agentRunBudgetBodySchema.optional(),
  })
  .strict();

export const PlanReportQualityIssueSchema = z.enum([
  "empty_answer",
  "shell_only",
  "content_too_short",
  "missing_scan_section",
  "missing_todo_section",
  "no_todos",
]);

export const PlanReportQualitySchema = z
  .object({
    acceptable: z.boolean(),
    issues: z.array(PlanReportQualityIssueSchema),
    score: z.number().int().min(0).max(100),
  })
  .strict();

const planReportEvidenceStepSourceSchema = z
  .object({
    iteration: nonNegativeInteger,
    tool: nonBlankString,
    permission: z.enum(["read", "write", "shell", "network", "dangerous"]).optional(),
    ok: z.boolean(),
    executed: z.boolean().optional(),
    blocked: z.boolean().optional(),
    outcomeClass: z
      .enum(["execution_error", "observation_failure", "observation_success"])
      .optional(),
    outcomeMessage: z.string().optional(),
    preflight: z.boolean().optional(),
  })
  .passthrough();

export const PlanReportAgentSuccessSourceSchema = z
  .object({
    runId: nonBlankString,
    taskId: nonBlankString,
    sessionId: nonBlankString.optional(),
    answer: z.string(),
    steps: z.array(planReportEvidenceStepSourceSchema),
    executionMeta: z
      .object({
        mode: z.literal("plan"),
        stopReason: AgentStopReasonSchema,
        userFacingState: PlanReportUserFacingStateSchema.optional(),
        userFacingLabel: z.string().optional(),
        usage: z
          .object({
            modelTurns: nonNegativeInteger,
            toolCalls: nonNegativeInteger,
            readCalls: nonNegativeInteger,
            runtimeMs: nonNegativeInteger,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export const PlanReportAgentErrorSourceSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    runId: nonBlankString.optional(),
    taskId: nonBlankString.optional(),
  })
  .passthrough();

export const PlanReportExecutionMetaSchema = z
  .object({
    mode: z.literal("plan"),
    stopReason: z.literal("completed"),
    userFacingState: PlanReportUserFacingStateSchema.optional(),
    userFacingLabel: z.string().optional(),
    usage: z
      .object({
        modelTurns: nonNegativeInteger,
        toolCalls: nonNegativeInteger,
        readCalls: nonNegativeInteger,
        runtimeMs: nonNegativeInteger,
      })
      .strict(),
  })
  .strict();

export const PlanAnalyzeResultSchema = z
  .object({
    userVisiblePlan: UserVisiblePlanSchema,
    runId: nonBlankString,
    taskId: nonBlankString,
    sessionId: nonBlankString.optional(),
    executionMeta: PlanReportExecutionMetaSchema,
    reportQuality: PlanReportQualitySchema,
    reportEnriched: z.boolean(),
    warning: z.string(),
    nextAction: z
      .object({
        activate: z.string(),
        compile: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.userVisiblePlan.sourceRunId !== result.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userVisiblePlan", "sourceRunId"],
        message: "UserVisiblePlan 必须绑定当前完成的 Agent Run",
      });
    }
    if (result.userVisiblePlan.sessionId !== result.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userVisiblePlan", "sessionId"],
        message: "UserVisiblePlan 与响应必须绑定同一会话",
      });
    }
    if (!result.reportQuality.acceptable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reportQuality", "acceptable"],
        message: "成功响应不能包含未通过质量门的报告",
      });
    }
    const expectedActivate = `POST /api/agent with activatePlan:true, userVisiblePlanId:${result.userVisiblePlan.id}`;
    const expectedCompile = `POST /api/plans/${result.userVisiblePlan.id}/compile`;
    if (result.nextAction.activate !== expectedActivate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextAction", "activate"],
        message: "activate 动作必须绑定当前 UserVisiblePlan",
      });
    }
    if (result.nextAction.compile !== expectedCompile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextAction", "compile"],
        message: "compile 动作必须绑定当前 UserVisiblePlan",
      });
    }
  });

export const PlanReportErrorResultSchema = z
  .object({
    error: z.string(),
    code: z.string(),
    runId: nonBlankString.optional(),
    taskId: nonBlankString.optional(),
  })
  .strict();

export const PlanReportNotFoundResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("MODEL_CLIENT_NOT_FOUND"),
  })
  .strict();

export const PlanReportSessionConflictResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_REPORT_SESSION_BLOCKED"),
    runId: nonBlankString.optional(),
    taskId: nonBlankString.optional(),
  })
  .strict();

export const PlanReportQualityLowResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_REPORT_QUALITY_LOW"),
    quality: PlanReportQualitySchema,
    runId: nonBlankString,
    taskId: nonBlankString,
    sessionId: nonBlankString.optional(),
    readToolSteps: nonNegativeInteger,
    hint: z.string(),
  })
  .strict();

export const PlanReportRunIncompleteResultSchema = z
  .object({
    error: z.string(),
    code: z.literal("PLAN_REPORT_RUN_INCOMPLETE"),
    stopReason: PlanReportIncompleteStopReasonSchema,
    runId: nonBlankString,
    taskId: nonBlankString,
    sessionId: nonBlankString.optional(),
    hint: z.string(),
  })
  .strict();

export const PlanReportUnprocessableResultSchema = z.union([
  PlanReportQualityLowResultSchema,
  PlanReportRunIncompleteResultSchema,
]);

export type PlanReportRequest = z.infer<typeof PlanReportRequestSchema>;
export type PlanReportQuality = z.infer<typeof PlanReportQualitySchema>;
export type PlanReportQualityIssue = z.infer<typeof PlanReportQualityIssueSchema>;
