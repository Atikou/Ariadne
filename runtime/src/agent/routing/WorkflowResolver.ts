import type { ModelTaskType } from "../../model/taskType.js";
import { defaultWorkflowPlanner } from "../WorkflowPlanner.js";
import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import { runModeForIntent } from "../intentPatterns.js";
import type { TaskContext } from "../task/TaskContext.js";
import type { IntentDecision, IntentDecisionSource } from "./IntentDecision.js";
import { adjudicateIntentCandidate } from "./IntentSemanticAdjudicator.js";
import { resolveLegacyIntentFallback } from "./LegacyIntentFallback.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";
import { inferRequiredSideEffectsFromMessage } from "./SideEffectInference.js";
import {
  evaluateTaskBoundary,
  workflowSatisfiesSideEffects,
  type TaskBoundaryDecision,
} from "./TaskBoundaryDecision.js";

export interface WorkflowResolveInput {
  message: string;
  candidate: IntentDecision;
  candidateSource: IntentDecisionSource;
  signals: MessageContinuationSignals;
  boundary: TaskBoundaryDecision;
  taskContext?: TaskContext;
  taskType?: ModelTaskType;
}

/**
 * 综合 AI/legacy 候选 + 边界 + 弱信号，输出可执行的 intent/workflow。
 * AI 主判语义，代码做结构化裁决与副作用兼容重解析。
 */
export function resolveWorkflow(input: WorkflowResolveInput): IntentDecision {
  const adjudicated = adjudicateIntentCandidate({
    candidate: input.candidate,
    candidateSource: input.candidateSource,
    message: input.message,
    signals: input.signals,
    boundary: input.boundary,
    taskContext: input.taskContext,
  });
  return reconcileWorkflowSideEffects(
    adjudicated,
    input.message,
    input.signals,
    input.boundary,
    input.taskType,
  );
}

function reconcileWorkflowSideEffects(
  decision: IntentDecision,
  message: string,
  signals: MessageContinuationSignals,
  boundary: TaskBoundaryDecision,
  taskType?: ModelTaskType,
): IntentDecision {
  const required = boundary.requiredSideEffects.length
    ? boundary.requiredSideEffects
    : inferRequiredSideEffectsFromMessage(message, signals);

  if (required.length === 0) return decision;
  if (workflowSatisfiesSideEffects(decision.workflowType, required)) {
    if (boundary.breaksContinuation) {
      return {
        ...decision,
        isContinuation: false,
        isNewTask: true,
        source:
          decision.source === "intent_adjudicator" ? "intent_adjudicator" : "task_boundary",
        needsRunCommand: required.includes("shell"),
        needsWrite: required.includes("write"),
        reason: `${boundary.reason}；重解析为 ${decision.intent}/${decision.workflowType}`,
        confidence: Math.max(decision.confidence, 0.78),
      };
    }
    return {
      ...decision,
      needsRunCommand: required.includes("shell"),
      needsWrite: required.includes("write"),
    };
  }

  const legacy = resolveLegacyIntentFallback({ message, taskType });
  if (workflowSatisfiesSideEffects(legacy.workflowType, required)) {
    return {
      ...legacy,
      isContinuation: false,
      isNewTask: boundary.breaksContinuation || legacy.isNewTask,
      needsRunCommand: required.includes("shell"),
      needsWrite: required.includes("write"),
      reason: boundary.breaksContinuation
        ? `${boundary.reason}；重解析为 ${legacy.intent}/${legacy.workflowType}`
        : `requiredSideEffects 与 ${decision.workflowType} 不兼容，重解析为 ${legacy.workflowType}`,
      source: "task_boundary",
      confidence: Math.max(decision.confidence, legacy.confidence, 0.78),
    };
  }

  if (required.includes("shell")) {
    const route = defaultWorkflowRouter.routeIntent("run");
    const mode = runModeForIntent("run");
    return {
      ...decision,
      mode,
      modeSource: "inferred",
      intent: "run",
      workflowType: route.workflowType,
      workflowPlan: defaultWorkflowPlanner.plan(message, mode, "run"),
      isContinuation: decision.isContinuation,
      isNewTask: boundary.breaksContinuation ? true : decision.isNewTask,
      needsRunCommand: true,
      reason: boundary.reason || `任务需要 shell，切换到 ${route.workflowType}`,
      source: "task_boundary",
      confidence: 0.82,
    };
  }

  if (required.includes("write")) {
    const route = defaultWorkflowRouter.routeIntent("edit");
    const mode = runModeForIntent("edit");
    return {
      ...decision,
      mode,
      modeSource: "inferred",
      intent: "edit",
      workflowType: route.workflowType,
      workflowPlan: defaultWorkflowPlanner.plan(message, mode, "edit"),
      isContinuation: decision.isContinuation,
      isNewTask: boundary.breaksContinuation ? true : decision.isNewTask,
      needsWrite: true,
      reason: boundary.reason || `任务需要 write，切换到 ${route.workflowType}`,
      source: decision.isContinuation ? "task_continuation" : "task_boundary",
      confidence: Math.max(decision.confidence, 0.82),
    };
  }

  return decision;
}

/** 任务续写：保留 taskId/续写标记，workflow 仍经副作用兼容重解析。 */
export function resolveForContinuation(
  input: WorkflowResolveInput & {
    continuation: import("./TaskContinuationEngine.js").TaskContinuationDecision;
  },
): IntentDecision {
  const intent = input.continuation.inheritIntent!;
  const candidate: IntentDecision = {
    mode: runModeForIntent(intent),
    modeSource: "inferred",
    intent,
    workflowType: input.continuation.inheritWorkflowType!,
    workflowPlan: null,
    isContinuation: true,
    isNewTask: false,
    confidence: Math.max(0.85, input.continuation.score),
    reason: input.continuation.reason,
    source: "task_continuation",
    inheritedTaskId: input.continuation.inheritedTaskId ?? input.taskContext?.taskId,
    previousWorkflowType: input.taskContext?.workflowType,
    continuationScore: input.continuation.score,
    continuationSignals: input.continuation.signals,
  };
  const resolved = resolveWorkflow({
    ...input,
    candidate,
    candidateSource: "task_continuation",
  });
  return {
    ...resolved,
    isContinuation: true,
    isNewTask: false,
    inheritedTaskId: candidate.inheritedTaskId,
    previousWorkflowType: candidate.previousWorkflowType,
    continuationScore: input.continuation.score,
    continuationSignals: input.continuation.signals,
    source:
      resolved.source === "task_boundary" || resolved.source === "intent_adjudicator"
        ? resolved.source
        : "task_continuation",
  };
}

export { evaluateTaskBoundary, inferRequiredSideEffectsFromMessage };
