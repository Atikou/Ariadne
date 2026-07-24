import type { AgentIntentType } from "../IntentTypes.js";
import type { TaskContext, UpdateTaskContextFromRunInput } from "./TaskContext.js";
import { SessionTaskStore } from "./SessionTaskStore.js";
import { resolvePhaseFromRun } from "./sessionTaskPhase.js";
import { isContinuationEligibleIntent } from "../routing/ContinuationDetector.js";
import { isAgentStepFailureFeedback, isRuntimeDiagnosticFeedback } from "../agentFailureFeedback.js";

const SIDE_EFFECT_INTENTS = new Set<AgentIntentType>([
  "edit",
  "generate_file",
  "refactor",
  "run",
  "verify",
  "debug",
]);

const READONLY_INTENTS = new Set<AgentIntentType>(["answer", "summarize", "search"]);

function shouldPreserveActiveTaskContext(
  existing: TaskContext,
  input: UpdateTaskContextFromRunInput,
): boolean {
  if (!existing.isActive) return false;

  const readonlyRun = READONLY_INTENTS.has(input.intent);
  const activeSideEffect = SIDE_EFFECT_INTENTS.has(existing.intent);

  if (activeSideEffect && readonlyRun) {
    if (isContinuationEligibleIntent(existing.intent)) return true;
  }

  if (!isContinuationEligibleIntent(existing.intent)) return false;
  const informational = readonlyRun;
  if (!informational) return false;
  const goal = input.goal ?? "";
  return isRuntimeDiagnosticFeedback(goal) || isAgentStepFailureFeedback(goal);
}

/** 会话级连续任务上下文：SQLite + 内存缓存。 */
export class SessionTaskManager {
  private readonly store: SessionTaskStore;
  private readonly memory = new Map<string, TaskContext>();

  constructor(db?: import("node:sqlite").DatabaseSync) {
    this.store = new SessionTaskStore(db);
  }

  getContext(sessionId: string): TaskContext | undefined {
    const persisted = this.store.get(sessionId);
    if (persisted) return persisted;
    return this.memory.get(sessionId);
  }

  markInactive(sessionId: string): void {
    this.memory.delete(sessionId);
    this.store.markInactive(sessionId);
  }

  updateFromRun(input: UpdateTaskContextFromRunInput): void {
    const existing = this.getContext(input.sessionId);
    if (existing && shouldPreserveActiveTaskContext(existing, input)) {
      const context: TaskContext = {
        ...existing,
        lastRunId: input.runId,
        lastFailure: input.failureSummary ?? existing.lastFailure ?? input.goal.slice(0, 500),
        currentPhase: input.failed ? "failed" : existing.currentPhase,
        updatedAt: new Date().toISOString(),
      };
      this.memory.set(input.sessionId, context);
      this.store.upsert(context);
      return;
    }

    const phase = resolvePhaseFromRun(input);
    const effectiveIntent = input.reconciledIntent ?? input.intent;
    const effectiveWorkflow = input.reconciledWorkflowType ?? input.workflowType;
    const context: TaskContext = {
      sessionId: input.sessionId,
      taskId: input.taskId,
      goal: input.goal,
      currentPhase: phase,
      intent: effectiveIntent,
      workflowType: effectiveWorkflow,
      entryIntent: input.entryIntent ?? existing?.entryIntent ?? input.intent,
      entryWorkflowType: input.entryWorkflowType ?? existing?.entryWorkflowType ?? input.workflowType,
      reconciledIntent: input.reconciledIntent ?? effectiveIntent,
      reconciledWorkflowType: input.reconciledWorkflowType ?? effectiveWorkflow,
      lastRunId: input.runId,
      lastFailure: input.failureSummary ?? (phase === "failed" ? input.goal.slice(0, 500) : undefined),
      lastStopReason: input.stopReason,
      lastCompletionStatus: input.completionStatus,
      lastCompletedAt: phase === "completed" ? new Date().toISOString() : undefined,
      lastSideEffectSummary: input.sideEffectSummary,
      relatedFiles: input.relatedFiles,
      isActive: true,
      updatedAt: new Date().toISOString(),
    };
    this.memory.set(input.sessionId, context);
    this.store.upsert(context);
  }
}
