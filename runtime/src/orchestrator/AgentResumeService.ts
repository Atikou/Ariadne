import type { LoopChatFn } from "../agent/AgentLoop.js";
import type { AgentModelTurnEvent } from "../agent/AgentModelTurn.js";
import type { AgentRuntimeServices } from "../agent/AgentRuntimeServices.js";
import {
  defaultPausedRunStore,
  type PausedRunSnapshot,
  type PausedRunStore,
} from "../agent/PausedRunStore.js";
import type { RunBudget } from "../agent/RunPolicyTypes.js";
import { AgentTimelineService } from "../agent/timeline/AgentTimelineService.js";
import type { TaskStore } from "../context/stores.js";
import type { TaskRecord } from "../context/types.js";
import type { ApiResult } from "../core/apiResult.js";
import { parseModelTaskTypeOrError } from "../model/taskType.js";
import type { PermissionRequestStore } from "../policy/PermissionRequestStore.js";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import type { AgentExecutionEngineRegistry } from "./AgentExecutionEngine.js";
import type { AgentRunLifecycle } from "./AgentRunLifecycle.js";
import type { AgentRunRegistry } from "./AgentRunRegistry.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import type { RunTerminalEventBus } from "./RunTerminalEventBus.js";
import type { RunStateStore } from "./RunStateStore.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import type { TaskService } from "./TaskService.js";
import { toPublicError } from "../util/publicError.js";

export interface AgentResumeServiceDeps {
  agentRuntime: AgentRuntimeServices;
  sessionWorkspace: SessionWorkspaceResolver;
  taskService: Pick<TaskService, "resolveOrCreateTask">;
  tasks: TaskStore;
  runs: RunAggregateRepository;
  runStateStore: RunStateStore;
  agentRunRegistry: AgentRunRegistry;
  executionEngines: AgentExecutionEngineRegistry;
  agentRunLifecycle: AgentRunLifecycle;
  makeChatFn: (forceClient?: string) => LoopChatFn;
  permissionRequestStore?: PermissionRequestStore;
  planHandoffStore?: PlanHandoffStore;
  pausedRunStore?: PausedRunStore;
  runTerminalEvents?: RunTerminalEventBus;
}

export interface AgentResumeCallbacks {
  onModelTurn?: (turn: AgentModelTurnEvent) => void;
  onRunChanged?: (runId: string) => void;
}

interface PausedResumeExecution {
  runId: string;
  sessionId?: string;
  task: TaskRecord;
  snapshot: PausedRunSnapshot;
  policy: ReturnType<AgentRuntimeServices["runPolicyManager"]["resolve"]>;
  makeChat?: LoopChatFn;
  scopedGrants?: ScopedApprovedPermissions;
  resumeKind: "permission" | "plan_handoff";
  callbacks?: AgentResumeCallbacks;
}

/** Owns budget, tool-permission, and plan-handoff Agent resume use cases. */
export class AgentResumeService {
  constructor(private readonly deps: AgentResumeServiceDeps) {}

  async resumeBudget(
    body: unknown,
    makeChat?: LoopChatFn,
    callbacks?: AgentResumeCallbacks,
  ): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      runId?: string;
      budget?: Partial<RunBudget>;
      message?: string;
      sensitive?: boolean;
      taskType?: string;
    };
    const runId = (payload.runId ?? "").trim();
    if (!runId) return { status: 400, body: { error: "runId 不能为空" } };

    const run = this.deps.runs.get(runId);
    if (!run) return { status: 404, body: { error: "运行记录不存在", runId } };
    if (run.kind !== "agent") {
      return { status: 400, body: { error: "仅 agent 类型 Run 支持续跑", runId, kind: run.kind } };
    }
    if (run.status !== "paused" || run.waitReason?.code !== "budget_exhausted") {
      return {
        status: 409,
        body: {
          error: "Run is not waiting for additional execution budget.",
          runId,
          status: run.status,
          waitReason: run.waitReason?.code,
        },
      };
    }

    const state = this.deps.runStateStore.get(runId);
    if (!state || state.status !== "resumable") {
      return {
        status: 400,
        body: {
          error: "该 Run 不可续跑（无 resumable 状态或已完成）",
          runId,
          pendingSteps: state?.pendingSteps,
        },
      };
    }

    const taskTypeParsed = parseModelTaskTypeOrError(payload.taskType);
    if (!taskTypeParsed.ok) return { status: 400, body: { error: taskTypeParsed.error } };

    const policy = this.deps.agentRuntime.runPolicyManager.resolve({
      requestedMode: state.mode,
      forceMode: true,
      sessionId: state.sessionId,
      requestedPermissionPolicy: state.permissionPolicy,
      budget: payload.budget,
      taskType: taskTypeParsed.taskType,
      message: state.goal,
    });
    const message = (payload.message ?? "").trim() || state.goal;
    const sessionId = state.sessionId;
    const task = state.taskId
      ? this.deps.tasks.get(state.taskId)
      : this.deps.taskService.resolveOrCreateTask(sessionId, state.goal.slice(0, 500));
    if (!task) return { status: 404, body: { error: "关联 task 不存在", taskId: state.taskId } };

    const ctx = { message, sessionId, task, run: { id: runId } };
    let registered = false;

    try {
      await this.deps.agentRunRegistry.waitUntilIdle(runId);
      const current = this.deps.runs.get(runId);
      if (!current) return { status: 404, body: { error: "Run not found.", runId } };
      if (current.status !== "paused" || current.waitReason?.code !== "budget_exhausted") {
        return {
          status: 409,
          body: {
            error: "Run is no longer waiting for additional execution budget.",
            runId,
            status: current.status,
          },
        };
      }
      this.deps.runs.execute({
        type: "run.start",
        runId,
        expectedAggregateVersion: current.aggregateVersion,
      });
      callbacks?.onRunChanged?.(runId);
      this.deps.tasks.update(task.id, { status: "running" });
      const abortController = this.deps.agentRunRegistry.register(runId, "agent");
      registered = true;
      const workspaceRoot = this.deps.sessionWorkspace.workspaceForSession(sessionId);
      if (!sessionId) throw new Error("resumable_run_session_missing");
      const timeline = new AgentTimelineService({
        projectRoot: workspaceRoot,
        storageRoot: this.deps.sessionWorkspace.activityRootForSession(sessionId),
      });
      timeline.resumeRun({
        id: runId,
        goal: state.goal,
        sessionId,
        metadata: { userInput: state.goal, mode: policy.mode, projectRoot: workspaceRoot },
      });
      const engine = this.deps.executionEngines.create({
        chat: makeChat ?? this.deps.makeChatFn(),
        autoConfirm: false,
        sensitive: payload.sensitive,
        taskType: taskTypeParsed.taskType,
        policy,
        persistContext: Boolean(sessionId),
        sessionId,
        projectId: this.deps.sessionWorkspace.projectIdForSession(sessionId),
        runId,
        taskId: task.id,
        resumeState: state,
        signal: abortController.signal,
        timeline,
        onModelTurn: callbacks?.onModelTurn,
      }, state.executionEngineKind);
      this.deps.agentRunLifecycle.traceResume(ctx, {
        resumeKind: "budget",
        pendingSteps: state.pendingSteps,
        completedSteps: state.completedSteps,
      });
      const result = await engine.run(message);
      const bodyResult = this.deps.agentRunLifecycle.finalizeSuccess(ctx, result, { resumed: true });
      await this.publishTerminal(runId);
      return { status: 200, body: bodyResult };
    } catch (error) {
      const bodyResult = this.deps.agentRunLifecycle.finalizeFailure(ctx, error);
      await this.publishTerminal(runId);
      return { status: 502, body: bodyResult };
    } finally {
      if (registered) this.deps.agentRunRegistry.unregister(runId);
    }
  }

  async resumePermission(
    body: unknown,
    makeChat?: LoopChatFn,
    callbacks?: AgentResumeCallbacks,
  ): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      runId?: string;
      permissionRequestId?: string;
    };
    const runId = (payload.runId ?? "").trim();
    if (!runId) return { status: 400, body: { error: "runId 不能为空" } };
    const run = this.deps.runs.get(runId);
    if (!run) return { status: 404, body: { error: "运行记录不存在", runId } };
    if (run.kind !== "agent") {
      return { status: 400, body: { error: "仅 agent 类型 Run 支持续跑", runId, kind: run.kind } };
    }

    const store = this.deps.permissionRequestStore;
    if (!store) return { status: 500, body: { error: "权限申请服务未配置" } };
    const permissionRequestId = payload.permissionRequestId?.trim();
    const request = permissionRequestId
      ? store.get(permissionRequestId)
      : store.getApprovedByRunId(runId) ?? store.getPendingByRunId(runId);
    if (!request || request.status !== "approved") {
      return {
        status: 400,
        body: { error: "未找到已批准的权限申请", runId, permissionRequestId },
      };
    }
    if (request.runId !== runId) {
      return {
        status: 400,
        body: { error: "权限申请不属于当前 Run", runId, permissionRequestId: request.id },
      };
    }

    const snapshot = this.pausedStore().claim(runId);
    if (!snapshot) return this.missingSnapshot(runId, "permission");
    if (!snapshot.pendingAction) {
      return this.restoreConflict(
        snapshot,
        "权限续跑快照缺少被阻塞的工具调用；计划交接必须使用独立续跑入口",
      );
    }

    const sessionId = run.sessionId;
    let policy: PausedResumeExecution["policy"];
    let task: TaskRecord | null;
    try {
      policy = this.deps.agentRuntime.runPolicyManager.resolve({
        requestedMode: snapshot.mode,
        forceMode: true,
        sessionId,
        message: snapshot.goal,
        requestedPermissionPolicy: snapshot.permissionPolicy,
      });
      task = this.resolveTask(run.taskId, sessionId, snapshot);
    } catch (error) {
      return this.restorePreparationFailure(snapshot, error);
    }
    if (!task) return this.restoreMissingTask(runId, run.taskId, snapshot);

    return this.executePaused({
      runId,
      sessionId,
      task,
      snapshot,
      policy,
      makeChat,
      scopedGrants: request.approvedPermissions,
      resumeKind: "permission",
      callbacks,
    });
  }

  async resumePlanHandoff(
    body: unknown,
    makeChat?: LoopChatFn,
    callbacks?: AgentResumeCallbacks,
  ): Promise<ApiResult> {
    const payload = (body ?? {}) as {
      runId?: string;
      planHandoffId?: string;
    };
    const runId = (payload.runId ?? "").trim();
    if (!runId) return { status: 400, body: { error: "runId 不能为空" } };
    const run = this.deps.runs.get(runId);
    if (!run) return { status: 404, body: { error: "运行记录不存在", runId } };
    if (run.kind !== "agent") {
      return { status: 400, body: { error: "仅 agent 类型 Run 支持续跑", runId, kind: run.kind } };
    }

    const store = this.deps.planHandoffStore;
    if (!store) return { status: 500, body: { error: "计划交接服务未配置" } };
    const planHandoffId = payload.planHandoffId?.trim();
    const handoff = planHandoffId
      ? store.get(planHandoffId)
      : store.getApprovedByRunId(runId) ?? store.getPendingByRunId(runId);
    if (!handoff || handoff.status !== "approved") {
      return {
        status: 400,
        body: { error: "未找到已批准的计划交接", runId, planHandoffId },
      };
    }
    if (handoff.runId !== runId) {
      return {
        status: 400,
        body: { error: "计划交接不属于当前 Run", runId, planHandoffId: handoff.id },
      };
    }

    const snapshot = this.pausedStore().claim(runId);
    if (!snapshot) return this.missingSnapshot(runId, "plan_handoff");
    if (snapshot.pendingAction || snapshot.resumeMode !== handoff.resumeMode) {
      return this.restoreConflict(
        snapshot,
        "计划交接快照类型不匹配；工具权限续跑必须使用独立续跑入口",
      );
    }

    const sessionId = run.sessionId;
    let policy: PausedResumeExecution["policy"];
    let task: TaskRecord | null;
    try {
      policy = this.deps.agentRuntime.runPolicyManager.resolve({
        requestedMode: snapshot.resumeMode,
        forceMode: true,
        sessionId,
        message: snapshot.goal,
        requestedPermissionPolicy: snapshot.permissionPolicy,
      });
      task = this.resolveTask(run.taskId, sessionId, snapshot);
    } catch (error) {
      return this.restorePreparationFailure(snapshot, error);
    }
    if (!task) return this.restoreMissingTask(runId, run.taskId, snapshot);

    return this.executePaused({
      runId,
      sessionId,
      task,
      snapshot,
      policy,
      makeChat,
      resumeKind: "plan_handoff",
      callbacks,
    });
  }

  private async executePaused(input: PausedResumeExecution): Promise<ApiResult> {
    const { runId, sessionId, task, snapshot } = input;
    const pausedStore = this.pausedStore();
    const ctx = { message: snapshot.goal, sessionId, task, run: { id: runId } };
    let registered = false;

    try {
      await this.deps.agentRunRegistry.waitUntilIdle(runId);
      const current = this.deps.runs.get(runId);
      if (!current) return { status: 404, body: { error: "Run not found.", runId } };
      const expectedStatus = input.resumeKind === "permission"
        ? "waiting_confirmation"
        : "waiting_plan_handoff";
      if (current.status !== expectedStatus) {
        return {
          status: 409,
          body: {
            error: "Run is no longer waiting for this approval.",
            runId,
            status: current.status,
            expectedStatus,
          },
        };
      }
      this.deps.runs.execute({
        type: "run.start",
        runId,
        expectedAggregateVersion: current.aggregateVersion,
      });
      input.callbacks?.onRunChanged?.(runId);
      this.deps.tasks.update(task.id, { status: "running" });
      const workspaceRoot = this.deps.sessionWorkspace.workspaceForSession(sessionId);
      if (!sessionId) throw new Error("resumable_run_session_missing");
      const timeline = new AgentTimelineService({
        projectRoot: workspaceRoot,
        storageRoot: this.deps.sessionWorkspace.activityRootForSession(sessionId),
      });
      timeline.resumeRun({
        id: runId,
        goal: snapshot.goal,
        sessionId,
        metadata: { userInput: snapshot.goal, mode: input.policy.mode, projectRoot: workspaceRoot },
      });
      const abortController = this.deps.agentRunRegistry.register(runId, "agent");
      registered = true;
      const engine = this.deps.executionEngines.create({
        chat: input.makeChat ?? this.deps.makeChatFn(),
        autoConfirm: false,
        policy: input.policy,
        allowedPermissions: snapshot.permissionCeiling,
        runGrantedPermissions: snapshot.runGrantedPermissions,
        handoffAuthorization: snapshot.handoffAuthorization,
        persistContext: Boolean(sessionId),
        sessionId,
        projectId: this.deps.sessionWorkspace.projectIdForSession(sessionId),
        runId,
        taskId: task.id,
        pausedRun: snapshot,
        scopedGrants: input.scopedGrants,
        pauseOnPermissionRequest: true,
        signal: abortController.signal,
        timeline,
        onModelTurn: input.callbacks?.onModelTurn,
      }, snapshot.execution.engineKind);
      this.deps.agentRunLifecycle.traceResume(ctx, { resumeKind: input.resumeKind });
      const result = await engine.run(snapshot.goal);
      const bodyResult = this.deps.agentRunLifecycle.finalizeSuccess(ctx, result, { resumed: true });
      pausedStore.completeClaim(snapshot);
      await this.publishTerminal(runId);
      return { status: 200, body: bodyResult };
    } catch (error) {
      let replacementSnapshotExists = false;
      try {
        const released = pausedStore.releaseClaim(snapshot);
        replacementSnapshotExists = !released && pausedStore.get(runId) != null;
      } catch (snapshotError) {
        const bodyResult = this.deps.agentRunLifecycle.finalizeFailure(ctx, snapshotError);
        await this.publishTerminal(runId);
        return { status: 502, body: bodyResult };
      }
      return {
        status: 502,
        body: this.deps.agentRunLifecycle.finalizeResumeFailure(ctx, error, {
          preserveWaitingDecision: replacementSnapshotExists,
        }),
      };
    } finally {
      if (registered) this.deps.agentRunRegistry.unregister(runId);
    }
  }

  private resolveTask(
    taskId: string | undefined,
    sessionId: string | undefined,
    snapshot: PausedRunSnapshot,
  ): TaskRecord | null {
    return taskId
      ? this.deps.tasks.get(taskId)
      : this.deps.taskService.resolveOrCreateTask(sessionId, snapshot.goal.slice(0, 500));
  }

  private async publishTerminal(runId: string): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (
      !run
      || (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled")
    ) {
      return;
    }
    await this.deps.runTerminalEvents?.publish({
      runId,
      status: run.status,
      source: "agent_resume",
      at: new Date().toISOString(),
    });
  }

  private restoreMissingTask(
    runId: string,
    taskId: string | undefined,
    snapshot: PausedRunSnapshot,
  ): ApiResult {
    try {
      this.pausedStore().releaseClaim(snapshot);
      return { status: 404, body: { error: "关联 task 不存在", taskId } };
    } catch (error) {
      return this.snapshotRestoreFailure(runId, error);
    }
  }

  private restoreConflict(snapshot: PausedRunSnapshot, message: string): ApiResult {
    try {
      this.pausedStore().releaseClaim(snapshot);
      return { status: 409, body: { error: message, runId: snapshot.runId } };
    } catch (error) {
      return this.snapshotRestoreFailure(snapshot.runId, error);
    }
  }

  private restorePreparationFailure(snapshot: PausedRunSnapshot, error: unknown): ApiResult {
    try {
      this.pausedStore().releaseClaim(snapshot);
    } catch (snapshotError) {
      return this.snapshotRestoreFailure(snapshot.runId, snapshotError);
    }
    const publicError = toPublicError(error, "准备续跑失败");
    return {
      status: 502,
      body: {
        error: publicError.message,
        code: publicError.code,
        runId: snapshot.runId,
        retryable: true,
      },
    };
  }

  private snapshotRestoreFailure(runId: string, error: unknown): ApiResult {
    const publicError = toPublicError(error, "恢复续跑快照失败");
    return { status: 500, body: { error: publicError.message, code: publicError.code, runId } };
  }

  private missingSnapshot(runId: string, kind: "permission" | "plan_handoff"): ApiResult {
    const isPlan = kind === "plan_handoff";
    return {
      status: 409,
      body: {
        error: isPlan
          ? "无可恢复的计划快照（服务可能已重启，或该批准已被执行）。请重新发起计划请求。"
          : "无可恢复的执行快照（服务可能已重启，或该批准已被执行）。请重新发起请求。",
        runId,
      },
    };
  }

  private pausedStore(): PausedRunStore {
    return this.deps.pausedRunStore ?? defaultPausedRunStore;
  }
}
