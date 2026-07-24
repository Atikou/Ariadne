import type { AgentRunResult } from "../agent/AgentLoop.js";
import { resolveAgentRunOutcome } from "../agent/AgentRunOutcome.js";
import type { TaskRecord } from "../context/types.js";
import type { TraceEvent, TraceLogger } from "../trace/TraceLogger.js";
import { toPublicError } from "../util/publicError.js";
import type { RunStore } from "./RunStore.js";
import type { RunStateStore } from "./RunStateStore.js";
import type { TaskService } from "./TaskService.js";
import type { RunState } from "./runStateTypes.js";

export interface AgentRunLifecycleContext {
  sessionId?: string;
  task: TaskRecord;
  run: { id: string };
}

export interface AgentRunLifecycleDeps {
  taskService: Pick<TaskService, "applyStateTransition">;
  runs: RunStore;
  runStateStore: RunStateStore;
  trace?: TraceLogger;
}

export type ResumeWaitingStatus = "waiting_confirmation" | "waiting_plan_handoff";

/** Owns the durable Run/Task/Trace transition for one Agent execution. */
export class AgentRunLifecycle {
  constructor(private readonly deps: AgentRunLifecycleDeps) {}

  traceStart(ctx: AgentRunLifecycleContext): void {
    this.writeTrace({
      type: "run_start",
      runId: ctx.run.id,
      kind: "agent",
      sessionId: ctx.sessionId,
      taskId: ctx.task.id,
    });
  }

  finalizeSuccess(
    ctx: AgentRunLifecycleContext,
    result: AgentRunResult,
    extra?: { resumed?: boolean },
  ): AgentRunResult & { runId: string; taskId: string; runState?: RunState | null; resumed?: boolean } {
    const awaitingPlanHandoff =
      result.awaitingPlanHandoff === true || result.executionMeta.stopReason === "awaiting_plan_handoff";
    const awaitingPermission =
      !awaitingPlanHandoff &&
      (result.awaitingPermission === true || result.executionMeta.stopReason === "awaiting_permission");
    const outcome = resolveAgentRunOutcome(result.executionMeta.stopReason);
    this.deps.taskService.applyStateTransition(ctx.task.id, ctx.sessionId, {
      status: outcome.taskStatus,
      summary: result.answer.slice(0, 500),
      releaseFromSession: outcome.releaseTaskFromSession,
    });

    const runState = result.reachedLimit ? this.deps.runStateStore.get(ctx.run.id) : null;
    this.deps.runs.update(ctx.run.id, {
      status: outcome.runStatus,
      error: null,
      resultJson: JSON.stringify({
        answer: result.answer,
        iterations: result.iterations,
        executionMeta: result.executionMeta,
        routerDecision: result.routerDecision,
        promptStrategy: result.promptStrategy,
        permissionRequest: result.permissionRequest,
        planHandoff: result.planHandoff,
        awaitingPermission,
        awaitingPlanHandoff,
        runState: runState
          ? { status: runState.status, pendingSteps: runState.pendingSteps, completedSteps: runState.completedSteps }
          : undefined,
        resumed: extra?.resumed,
      }),
    });
    this.writeTrace({
      type: "run_end",
      runId: ctx.run.id,
      kind: "agent",
      status: outcome.runStatus,
      resumed: extra?.resumed,
      resumable: runState?.status === "resumable",
      awaitingPermission,
      awaitingPlanHandoff,
    });
    return {
      ...result,
      runId: ctx.run.id,
      taskId: ctx.task.id,
      sessionId: ctx.sessionId,
      runState: runState ?? undefined,
      resumed: extra?.resumed,
    };
  }

  finalizeFailure(
    ctx: AgentRunLifecycleContext,
    error: unknown,
  ): { error: string; code: string; runId: string; taskId: string } {
    const publicError = toPublicError(error);
    this.deps.taskService.applyStateTransition(ctx.task.id, ctx.sessionId, {
      status: "failed",
      summary: publicError.message,
      releaseFromSession: false,
    });
    this.deps.runs.update(ctx.run.id, { status: "failed", error: publicError.message });
    this.writeTrace({ type: "run_end", runId: ctx.run.id, kind: "agent", status: "failed" });
    return {
      error: publicError.message,
      code: publicError.code,
      runId: ctx.run.id,
      taskId: ctx.task.id,
    };
  }

  finalizeResumeFailure(
    ctx: AgentRunLifecycleContext,
    error: unknown,
    waitingStatus: ResumeWaitingStatus,
  ): { error: string; code: string; runId: string; taskId: string; retryable: true } {
    const publicError = toPublicError(error);
    this.deps.taskService.applyStateTransition(ctx.task.id, ctx.sessionId, {
      status: "blocked",
      summary: publicError.message,
      releaseFromSession: false,
    });
    this.deps.runs.update(ctx.run.id, {
      status: waitingStatus,
      error: publicError.message,
    });
    this.writeTrace({
      type: "run_resume_failed",
      runId: ctx.run.id,
      kind: "agent",
      status: waitingStatus,
      retryable: true,
    });
    return {
      error: publicError.message,
      code: publicError.code,
      runId: ctx.run.id,
      taskId: ctx.task.id,
      retryable: true,
    };
  }

  traceResume(
    ctx: AgentRunLifecycleContext,
    details?: Record<string, unknown>,
  ): void {
    this.writeTrace({
      type: "run_resume",
      runId: ctx.run.id,
      kind: "agent",
      sessionId: ctx.sessionId,
      taskId: ctx.task.id,
      ...details,
    });
  }

  private writeTrace(event: Record<string, unknown>): void {
    try {
      this.deps.trace?.write(event as TraceEvent);
    } catch {
      // Trace is best-effort and must not change durable Run/Task state.
    }
  }
}
