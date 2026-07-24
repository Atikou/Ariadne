import type { ApiResult } from "../core/apiResult.js";
import type { PlanService } from "../plan/PlanService.js";
import {
  PlanAnalyzeResultSchema,
  PlanReportAgentErrorSourceSchema,
  PlanReportAgentSuccessSourceSchema,
  PlanReportErrorResultSchema,
  PlanReportQualityLowResultSchema,
  PlanReportRunIncompleteResultSchema,
  PlanReportSessionConflictResultSchema,
  type PlanReportRequest,
} from "../plan/PlanReportContracts.js";
import { resolvePlanReportMarkdown, countSuccessfulReadSteps } from "../plan/planReportEnrichment.js";
import { buildPlanAnalysisPrompt, renderUserVisiblePlan } from "../plan/UserPlanRenderer.js";
import { toPublicError } from "../util/publicError.js";
import type { LoopChatFn } from "./AgentLoop.js";
import type { AgentToolStep } from "./toolStep.js";

export interface PlanReportWorkflowOptions {
  planService: Pick<PlanService, "saveUserVisiblePlan">;
  runAgent: (body: unknown, makeChat?: LoopChatFn) => Promise<ApiResult>;
}

export type PlanReportWorkflowInput = PlanReportRequest & { makeChat?: LoopChatFn };

export class PlanReportWorkflow {
  constructor(private readonly options: PlanReportWorkflowOptions) {}

  async run(input: PlanReportWorkflowInput): Promise<ApiResult> {
    let result: ApiResult;
    try {
      result = await this.options.runAgent(
        {
          message: buildPlanAnalysisPrompt({ goal: input.goal, context: input.context }),
          mode: "plan",
          forceMode: true,
          sessionId: input.sessionId,
          clientName: input.clientName,
          autoConfirm: false,
          permissionPolicy: "readOnly",
          sensitive: true,
          skipPlanHandoff: true,
          budget: input.budget,
        },
        input.makeChat,
      );
    } catch (error) {
      return reportFailure(502, error, "计划报告 Agent 调用失败", "PLAN_REPORT_AGENT_FAILED");
    }

    if (result.status !== 200) return normalizeAgentFailure(result);

    const parsed = PlanReportAgentSuccessSourceSchema.safeParse(result.body);
    if (!parsed.success) {
      return reportFailure(
        500,
        "Agent 成功响应缺少可信 Run、Task 或执行终态",
        "计划报告 Agent 返回无效结果",
        "PLAN_REPORT_AGENT_RESULT_INVALID",
      );
    }
    const source = parsed.data;
    if (source.executionMeta.stopReason !== "completed") {
      return {
        status: 422,
        body: PlanReportRunIncompleteResultSchema.parse({
          error: "计划报告 Agent 未真实完成，本次结果不会保存为 UserVisiblePlan。",
          code: "PLAN_REPORT_RUN_INCOMPLETE",
          stopReason: source.executionMeta.stopReason,
          runId: source.runId,
          taskId: source.taskId,
          sessionId: source.sessionId,
          hint: "请先处理等待状态或调整预算后重新生成计划报告。",
        }),
      };
    }

    const evidenceSteps = toPlanReportEvidenceSteps(source.steps);
    const resolved = resolvePlanReportMarkdown({
      goal: input.goal,
      modelAnswer: source.answer,
      steps: evidenceSteps,
    });

    if (!resolved.quality.acceptable) {
      return {
        status: 422,
        body: PlanReportQualityLowResultSchema.parse({
          error:
            "计划报告质量不足：模型未输出有效 Markdown 计划，且无法从只读扫描结果补全。请换用更强模型、缩小分析范围，或确认工作区可读。",
          code: "PLAN_REPORT_QUALITY_LOW",
          quality: resolved.quality,
          runId: source.runId,
          taskId: source.taskId,
          sessionId: source.sessionId,
          readToolSteps: countSuccessfulReadSteps(evidenceSteps),
          hint: "可在智能体模式用流式执行观察工具调用与模型轮次。",
        }),
      };
    }

    let userVisiblePlan;
    try {
      userVisiblePlan = this.options.planService.saveUserVisiblePlan(
        renderUserVisiblePlan({
          sourceRunId: source.runId,
          sessionId: source.sessionId ?? input.sessionId,
          goal: input.goal,
          markdown: resolved.markdown,
        }),
      );
    } catch (error) {
      return reportFailure(
        500,
        error,
        "保存用户可见计划失败",
        "PLAN_REPORT_PERSISTENCE_FAILED",
        source,
      );
    }

    return {
      status: 200,
      body: PlanAnalyzeResultSchema.parse({
        userVisiblePlan,
        runId: source.runId,
        taskId: source.taskId,
        sessionId: source.sessionId ?? input.sessionId,
        executionMeta: {
          mode: "plan",
          stopReason: "completed",
          userFacingState: source.executionMeta.userFacingState,
          userFacingLabel: source.executionMeta.userFacingLabel,
          usage: {
            modelTurns: source.executionMeta.usage.modelTurns,
            toolCalls: source.executionMeta.usage.toolCalls,
            readCalls: source.executionMeta.usage.readCalls,
            runtimeMs: source.executionMeta.usage.runtimeMs,
          },
        },
        reportQuality: resolved.quality,
        reportEnriched: resolved.enriched,
        warning: resolved.enriched
          ? "模型原始回答过短，报告已由只读扫描结果自动补全；编译前请人工审阅 Todo。"
          : "UserVisiblePlan is for review only and cannot be executed directly; compile, approve, then execute.",
        nextAction: {
          activate: `POST /api/agent with activatePlan:true, userVisiblePlanId:${userVisiblePlan.id}`,
          compile: `POST /api/plans/${userVisiblePlan.id}/compile`,
        },
      }),
    };
  }
}

function normalizeAgentFailure(result: ApiResult): ApiResult {
  const parsed = PlanReportAgentErrorSourceSchema.safeParse(result.body);
  const source = parsed.success ? parsed.data : {};
  if (result.status === 409) {
    const message = sanitizeMessage(source.error, "当前会话有未处理的 Agent 等待状态");
    return {
      status: 409,
      body: PlanReportSessionConflictResultSchema.parse({
        error: message,
        code: "PLAN_REPORT_SESSION_BLOCKED",
        runId: source.runId,
        taskId: source.taskId,
      }),
    };
  }
  if (result.status === 502) {
    const message = sanitizeMessage(source.error, "计划报告 Agent 执行失败");
    const code = validPublicCode(source.code) ? source.code : "PLAN_REPORT_AGENT_FAILED";
    return {
      status: 502,
      body: PlanReportErrorResultSchema.parse({
        error: message,
        code,
        runId: source.runId,
        taskId: source.taskId,
      }),
    };
  }
  return reportFailure(
    500,
    `Agent 返回未声明状态 ${result.status}`,
    "计划报告 Agent 返回无效状态",
    "PLAN_REPORT_AGENT_RESULT_INVALID",
    source,
  );
}

function reportFailure(
  status: 500 | 502,
  error: unknown,
  fallback: string,
  code: string,
  identity?: { runId?: string; taskId?: string },
): ApiResult {
  const publicError = toPublicError(error, fallback);
  return {
    status,
    body: PlanReportErrorResultSchema.parse({
      error: publicError.message,
      code,
      runId: identity?.runId,
      taskId: identity?.taskId,
    }),
  };
}

function sanitizeMessage(message: string | undefined, fallback: string): string {
  return toPublicError(message ?? fallback, fallback).message;
}

function validPublicCode(code: string | undefined): code is string {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code);
}

function toPlanReportEvidenceSteps(
  steps: Array<Record<string, unknown> & {
    iteration: number;
    tool: string;
    permission?: AgentToolStep["permission"];
    ok: boolean;
    executed?: boolean;
    blocked?: boolean;
    outcomeClass?: AgentToolStep["outcomeClass"];
    outcomeMessage?: string;
    preflight?: boolean;
  }>,
): AgentToolStep[] {
  return steps.map((step) => ({
    iteration: step.iteration,
    tool: step.tool,
    input: {},
    permission: step.permission,
    ok: step.ok,
    executed: step.executed,
    blocked: step.blocked,
    outcomeClass: step.outcomeClass,
    outcomeMessage: step.outcomeMessage,
    output: extractEvidenceText(step),
    preflight: step.preflight,
  }));
}

function extractEvidenceText(step: Record<string, unknown>): string {
  const layers = asRecord(step.resultLayers);
  const display = asRecord(layers?.userDisplay);
  const candidates = [
    typeof layers?.userDisplay === "string" ? layers.userDisplay : undefined,
    typeof display?.summary === "string" ? display.summary : undefined,
    typeof layers?.modelVisible === "string" ? layers.modelVisible : undefined,
    typeof step.outcomeMessage === "string" ? step.outcomeMessage : undefined,
    typeof step.output === "string" ? step.output : serializeEvidence(step.output),
  ];
  return candidates.find((candidate) => candidate?.trim())?.trim().slice(0, 6000) ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function serializeEvidence(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
