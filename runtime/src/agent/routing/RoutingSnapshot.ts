import type { TaskContext } from "../task/TaskContext.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";
import type { IntentDecision } from "./IntentDecision.js";
import type { TaskBoundaryDecision } from "./TaskBoundaryDecision.js";
import type { TaskContinuationDecision } from "./TaskContinuationEngine.js";

/** 入口裁决快照：全链路只读 effectiveTaskContext，避免 markInactive 后局部 ctx 污染。 */
export interface RoutingSnapshot {
  rawTaskContext?: TaskContext;
  effectiveTaskContext?: TaskContext;
  signals: MessageContinuationSignals;
  boundary: TaskBoundaryDecision;
  continuation: TaskContinuationDecision;
  aiDecision?: IntentDecision | null;
  legacyDecision?: IntentDecision;
  finalDecision?: IntentDecision;
}

export function buildRoutingSnapshot(input: {
  taskContext?: TaskContext;
  signals: MessageContinuationSignals;
  boundary: TaskBoundaryDecision;
  continuation: TaskContinuationDecision;
  aiDecision?: IntentDecision | null;
}): RoutingSnapshot {
  const shouldClearContext =
    input.boundary.breaksContinuation ||
    input.signals.explicitNewTask ||
    input.continuation.kind === "new_task";

  return {
    rawTaskContext: input.taskContext,
    effectiveTaskContext: shouldClearContext ? undefined : input.taskContext,
    signals: input.signals,
    boundary: input.boundary,
    continuation: input.continuation,
    aiDecision: input.aiDecision,
  };
}

export function shouldMarkSessionInactive(snapshot: RoutingSnapshot): boolean {
  return (
    snapshot.boundary.breaksContinuation ||
    snapshot.signals.explicitNewTask ||
    snapshot.continuation.kind === "new_task"
  );
}
