import type { ApiResult } from "../core/apiResult.js";
import {
  StepExecutionDeferredError,
  StepExecutionError,
  type StepContext,
  type StepExecutor,
  type StepResult,
} from "./TaskRunner.js";
import type { PlanStep } from "./types.js";
import type { RunBudget } from "./RunPolicyTypes.js";
import type {
  AgentCompletionContext,
  CompletionCriterionInput,
} from "./completion/TaskCompletionContract.js";

export type AgentLoopRunFn = (body: unknown, completion?: AgentCompletionContext) => Promise<ApiResult>;

export interface PlanStepAgentExecutorOptions {
  runAgent: AgentLoopRunFn;
  sessionId?: string;
  planGoal?: string;
  stepBudget?: Partial<RunBudget>;
}

/**
 * 将计划单步委派给 Agent 主循环（ReAct），用于 agent_loop 执行模式。
 */
export class PlanStepAgentExecutor implements StepExecutor {
  constructor(private readonly options: PlanStepAgentExecutorOptions) {}

  async execute(step: PlanStep, _ctx: StepContext): Promise<StepResult> {
    const message = [
      `请完成计划中的子任务（须产生真实副作用，若只读请明确说明）：`,
      `计划目标：${this.options.planGoal ?? step.title}`,
      `步骤 ID：${step.id}`,
      `标题：${step.title}`,
      step.objective ? `目标：${step.objective}` : "",
      step.description ? `说明：${step.description}` : "",
      step.acceptance ? `验收：${step.acceptance}` : "",
      step.tool ? `建议首选工具：${step.tool}` : "",
      step.requiredContext?.length ? `相关上下文：${step.requiredContext.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const budget = {
      maxModelTurns: 10,
      maxToolCalls: 16,
      maxReadCalls: 12,
      maxWriteCalls: 4,
      maxShellCalls: 2,
      ...this.options.stepBudget,
    };

    const result = await this.options.runAgent(
      {
        message,
        mode: "implement",
        sessionId: this.options.sessionId,
        autoConfirm: false,
        budget,
        taskType: "codegen",
      },
      { completionCriteria: buildPlanStepCompletionCriteria(step) },
    );

    if (result.status !== 200) {
      const body = result.body as { error?: string };
      throw new StepExecutionError(
        body.error ?? `Agent 子运行失败（HTTP ${result.status}）`,
      );
    }

    const body = result.body as {
      answer?: string;
      runId?: string;
      executionMeta?: {
        workflowDiffs?: unknown[];
        toolCalls?: number;
        stopReason?: string;
        completionStatus?: string;
        completionEvidence?: { missingRequirementIds?: string[] };
      };
    };
    const deferredStopReason = deferredAgentStopReason(body.executionMeta?.stopReason);
    if (body.runId && deferredStopReason) {
      throw new StepExecutionDeferredError(
        `Agent 子运行已暂停：${deferredStopReason}`,
        body.runId,
        deferredStopReason,
      );
    }
    if (
      body.executionMeta?.stopReason !== "completed" ||
      body.executionMeta?.completionStatus !== "completed_success"
    ) {
      const missing = body.executionMeta?.completionEvidence?.missingRequirementIds?.join(", ");
      throw new StepExecutionError(
        [
          `Agent 子运行未通过完成合同：${body.executionMeta?.stopReason ?? "missing_stop_reason"}`,
          `completionStatus=${body.executionMeta?.completionStatus ?? "missing_completion_status"}`,
          missing ? `missingEvidence=${missing}` : "",
        ].filter(Boolean).join("；"),
        body.runId ? `agent:${body.runId}` : undefined,
      );
    }
    const diffHint =
      Array.isArray(body.executionMeta?.workflowDiffs) && body.executionMeta.workflowDiffs.length > 0
        ? `\n[workflowDiffs=${body.executionMeta.workflowDiffs.length}]`
        : "";
    const output = `${body.answer ?? "(无最终回答)"}${diffHint}`.trim();
    return { output, toolCallId: body.runId ? `agent:${body.runId}` : undefined };
  }
}

function deferredAgentStopReason(
  value: string | undefined,
): StepExecutionDeferredError["childStopReason"] | undefined {
  if (
    value === "awaiting_permission"
    || value === "awaiting_plan_handoff"
    || value === "budget_exhausted"
  ) {
    return value;
  }
  return undefined;
}

export function buildPlanStepCompletionCriteria(step: PlanStep): CompletionCriterionInput[] {
  const requiresWrite = step.requiredPermissions.includes("write") || step.requiredPermissions.includes("dangerous");
  const criteria: CompletionCriterionInput[] = [];
  const addAcceptanceCriterion = (description: string) => {
    const index = criteria.length;
    const targetPath = stringField(step.toolInput, "path");
    if (
      requiresWrite &&
      targetPath &&
      (step.tool === "write_file" || step.tool === "apply_patch")
    ) {
      criteria.push({
        id: `plan-step:${step.id}:criterion:${index + 1}`,
        description,
        evidenceKind: "write_readback",
        targetPath,
        required: true,
      });
      return;
    }
    if (step.tool && step.toolInput) {
      criteria.push({
        id: `plan-step:${step.id}:criterion:${index + 1}`,
        description,
        evidenceKind: "tool_success",
        toolNames: [step.tool],
        expectedInputSubset: step.toolInput,
        afterLastWrite: requiresWrite,
        required: true,
      });
      return;
    }
    criteria.push({
      id: `plan-step:${step.id}:criterion:${index + 1}`,
      description,
      evidenceKind: "manual",
      required: true,
    });
  };
  const addArtifactCriterion = (artifact: string) => {
    const index = criteria.length;
    if (requiresWrite) {
      criteria.push({
        id: `plan-step:${step.id}:criterion:${index + 1}`,
        description: `预期产物：${artifact}`,
        evidenceKind: "write_readback",
        targetPath: artifact,
        required: true,
      });
      return;
    }
    criteria.push({
      id: `plan-step:${step.id}:criterion:${index + 1}`,
      description: `预期产物：${artifact}`,
      evidenceKind: "manual",
      required: true,
    });
  };
  if (step.acceptance?.trim()) addAcceptanceCriterion(step.acceptance.trim());
  for (const artifact of step.expectedArtifacts ?? []) {
    if (artifact.trim()) addArtifactCriterion(artifact.trim());
  }
  return criteria;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item : undefined;
}
