import type { AgentIntentType } from "../IntentTypes.js";
import type { TaskContext, TaskSideEffectSummary } from "../task/TaskContext.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";

export type TaskContinuationKind = "inherit" | "new_task" | "uncertain";

export interface TaskContinuationDecision {
  kind: TaskContinuationKind;
  score: number;
  reason: string;
  inheritIntent?: AgentIntentType;
  inheritWorkflowType?: TaskContext["workflowType"];
  inheritedTaskId?: string;
  signals: Record<string, number | boolean>;
}

const SIDE_EFFECT_INTENTS = new Set<AgentIntentType>([
  "edit",
  "debug",
  "run",
  "verify",
  "refactor",
  "generate_file",
]);

const CONTINUATION_PHASES = new Set<TaskContext["currentPhase"]>([
  "editing",
  "debugging",
  "verifying",
  "completed",
]);

const INHERIT_SCORE_THRESHOLD = 0.55;
const GUARDRAIL_SCORE_THRESHOLD = 0.4;

export function isSideEffectTaskIntent(intent: AgentIntentType): boolean {
  return SIDE_EFFECT_INTENTS.has(intent);
}

export function hasRecentSideEffect(summary?: TaskSideEffectSummary): boolean {
  if (!summary) return false;
  return summary.wroteFiles.length > 0 || summary.ranShell;
}

function scoreContinuation(ctx: TaskContext, signals: MessageContinuationSignals): number {
  let score = 0;

  if (signals.isFailurePayload || signals.isRuntimeDiagnostic) {
    score += 0.85;
  }

  if (signals.isShortUtterance) score += 0.2;
  if (signals.hasAnaphora) score += 0.15;
  if (signals.lacksNewTaskAnchor) score += 0.2;

  if (hasRecentSideEffect(ctx.lastSideEffectSummary)) score += 0.3;
  if (ctx.lastStopReason === "completed") score += 0.1;
  if (ctx.currentPhase === "completed") score += 0.1;
  if (ctx.relatedFiles && ctx.relatedFiles.length > 0) score += 0.05;

  if (signals.explicitReadonlyRequest) score -= 0.6;

  return Math.max(0, Math.min(1, score));
}

/**
 * 基于会话任务状态 + 消息弱信号综合判断是否继承上一轮任务。
 * 不映射 intent/mode；继承时沿用 TaskContext 内已有 intent/workflowType。
 */
export function evaluateTaskContinuation(
  message: string,
  ctx: TaskContext | undefined,
  signals: MessageContinuationSignals,
): TaskContinuationDecision {
  const signalRecord: Record<string, number | boolean> = {
    isShortUtterance: signals.isShortUtterance,
    hasAnaphora: signals.hasAnaphora,
    lacksNewTaskAnchor: signals.lacksNewTaskAnchor,
    explicitNewTask: signals.explicitNewTask,
    explicitReadonlyRequest: signals.explicitReadonlyRequest,
    isFailurePayload: signals.isFailurePayload,
    isRuntimeDiagnostic: signals.isRuntimeDiagnostic,
  };

  if (!message.trim()) {
    return { kind: "uncertain", score: 0, reason: "空消息", signals: signalRecord };
  }

  if (signals.explicitNewTask) {
    return { kind: "new_task", score: 1, reason: "用户明确表示切换新任务", signals: signalRecord };
  }

  if (!ctx?.isActive || !isSideEffectTaskIntent(ctx.intent)) {
    return { kind: "uncertain", score: 0, reason: "无活跃副作用任务上下文", signals: signalRecord };
  }

  if (ctx.intent === "plan" && ctx.currentPhase === "waiting_approval") {
    return { kind: "uncertain", score: 0, reason: "计划待审批，需走 planHandoff", signals: signalRecord };
  }

  if (signals.isFailurePayload || signals.isRuntimeDiagnostic) {
    return {
      kind: "inherit",
      score: 0.9,
      reason: signals.isFailurePayload ? "粘贴工具失败步骤" : "运行/终端/浏览器诊断信息",
      inheritIntent: ctx.intent,
      inheritWorkflowType: ctx.workflowType,
      inheritedTaskId: ctx.taskId,
      signals: signalRecord,
    };
  }

  if (!CONTINUATION_PHASES.has(ctx.currentPhase)) {
    return { kind: "uncertain", score: 0, reason: "任务阶段不适合自动延续", signals: signalRecord };
  }

  const score = scoreContinuation(ctx, signals);
  signalRecord.continuationScore = score;

  if (signals.explicitReadonlyRequest) {
    return { kind: "uncertain", score, reason: "用户明确要求只读/审阅", signals: signalRecord };
  }

  if (score >= INHERIT_SCORE_THRESHOLD) {
    return {
      kind: "inherit",
      score,
      reason: "活跃副作用任务 + 短句增量信号达到延续阈值",
      inheritIntent: ctx.intent,
      inheritWorkflowType: ctx.workflowType,
      inheritedTaskId: ctx.taskId,
      signals: signalRecord,
    };
  }

  if (ctx.currentPhase === "failed" || ctx.lastFailure) {
    if (message.length <= 240 && score >= 0.25) {
      return {
        kind: "inherit",
        score,
        reason: "上一轮失败后补充说明",
        inheritIntent: ctx.intent,
        inheritWorkflowType: ctx.workflowType,
        inheritedTaskId: ctx.taskId,
        signals: signalRecord,
      };
    }
  }

  return { kind: "uncertain", score, reason: "延续信号不足", signals: signalRecord };
}

/** AI 分类器将活跃副作用任务降级为只读 intent 时的守卫阈值。 */
export const TASK_CONTINUATION_GUARDRAIL_THRESHOLD = GUARDRAIL_SCORE_THRESHOLD;

const READONLY_DOWNGRADE_INTENTS = new Set<AgentIntentType>([
  "review",
  "answer",
  "summarize",
  "search",
  "plan",
]);

export function shouldGuardrailOverrideAiClassifier(input: {
  ctx: TaskContext;
  aiIntent: AgentIntentType;
  aiIsContinuation: boolean;
  continuation: TaskContinuationDecision;
}): boolean {
  if (!input.ctx.isActive || !isSideEffectTaskIntent(input.ctx.intent)) return false;
  if (input.aiIsContinuation && isSideEffectTaskIntent(input.aiIntent)) return false;
  if (!READONLY_DOWNGRADE_INTENTS.has(input.aiIntent)) return false;
  if (input.continuation.kind === "inherit") return true;
  return (
    input.continuation.score >= GUARDRAIL_SCORE_THRESHOLD &&
    hasRecentSideEffect(input.ctx.lastSideEffectSummary)
  );
}
