import type { AgentRunResult, LoopChatFn } from "../agent/AgentLoop.js";
import type { AgentModelTurnEvent } from "../agent/AgentModelTurn.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import type { AgentCompletionContext } from "../agent/completion/TaskCompletionContract.js";
import type { AgentRuntimeServices } from "../agent/AgentRuntimeServices.js";
import { AgentTimelineService } from "../agent/timeline/AgentTimelineService.js";
import type { AgentActivityEvent } from "../agent/timeline/types.js";
import type { TaskRecord } from "../context/types.js";
import type { ApiResult } from "../core/apiResult.js";
import type { ToolPermission } from "../core/permissions.js";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type { PermissionRequestStore } from "../policy/PermissionRequestStore.js";
import { findBlockingAgentPause } from "../policy/permissionPauseGate.js";
import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type {
  AgentExecutionEngine,
  AgentExecutionEngineRegistry,
} from "./AgentExecutionEngine.js";
import type { AgentRunLifecycle } from "./AgentRunLifecycle.js";
import type { AgentRunRegistry } from "./AgentRunRegistry.js";
import type { RunAggregateRepository } from "../run/RunAggregateRepository.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import type { TaskService } from "./TaskService.js";
import {
  agentConversationRequestBodySchema,
  formatAgentRequestValidationError,
} from "./AgentRequestSchemas.js";
import type { HookManager } from "../hooks/HookManager.js";

export interface AgentRequestCallbacks {
  onStep?: (step: AgentToolStep) => void;
  onModelTurn?: (turn: AgentModelTurnEvent) => void;
  onToken?: (delta: string) => void;
  registerForCancel?: boolean;
  enableTimeline?: boolean;
  onActivityEvent?: (event: AgentActivityEvent) => void;
}

export interface PreparedAgentRequest {
  ctx: {
    message: string;
    system?: string;
    sessionId?: string;
    task: TaskRecord;
    run: { id: string };
    engine: AgentExecutionEngine;
  };
}

export interface AgentRequestExecutionOptions {
  parentRunId?: string;
  taskBinding?: "active" | "detached";
  /** Server-created tool visibility ceiling. This is never accepted from an HTTP Agent body. */
  permissionCeiling?: ToolPermission[];
  /** Permissions already authorized for this Run; a ceiling alone never grants execution. */
  grantedPermissions?: ToolPermission[];
  authorization?: {
    proposalId: string;
    grantId: string;
  };
  /** Server grants may cover ordinary calls, but forced confirmations still pause the Run. */
  pauseOnPermissionRequest?: boolean;
}

export interface AgentRequestServiceDeps {
  agentRuntime: AgentRuntimeServices;
  sessionWorkspace: SessionWorkspaceResolver;
  taskService: Pick<TaskService, "resolveOrCreateTask" | "createDetachedTask">;
  runs: RunAggregateRepository;
  agentRunRegistry: AgentRunRegistry;
  executionEngines: AgentExecutionEngineRegistry;
  agentRunLifecycle: AgentRunLifecycle;
  makeChatFn: (forceClient?: string) => LoopChatFn;
  planHandoffStore?: PlanHandoffStore;
  permissionRequestStore?: PermissionRequestStore;
  pausedRunStore?: PausedRunStore;
  hooks?: HookManager;
}

/** Owns the core Agent request preparation and one-shot execution lifecycle. */
export class AgentRequestService {
  constructor(private readonly deps: AgentRequestServiceDeps) {}

  async run(
    body: unknown,
    makeChat?: LoopChatFn,
    completionContext?: AgentCompletionContext,
    execution?: AgentRequestExecutionOptions,
  ): Promise<ApiResult> {
    const prepared = await this.prepare(
      body,
      makeChat,
      { registerForCancel: true, enableTimeline: true },
      completionContext,
      execution,
    );
    if ("error" in prepared) return prepared.error;
    const { ctx } = prepared;

    let result: AgentRunResult;
    try {
      this.deps.agentRunLifecycle.traceStart(ctx);
      result = await ctx.engine.run(ctx.message, ctx.system);
    } catch (error) {
      const resultBody = this.deps.agentRunLifecycle.finalizeFailure(ctx, error);
      try {
        await this.notifyPost(ctx.run.id);
      } catch (hookError) {
        this.deps.agentRunRegistry.unregister(ctx.run.id);
        return {
          status: 403,
          body: { error: String(hookError), runId: ctx.run.id, taskId: ctx.task.id },
        };
      }
      this.deps.agentRunRegistry.unregister(ctx.run.id);
      return { status: 502, body: resultBody };
    }
    const resultBody = this.deps.agentRunLifecycle.finalizeSuccess(ctx, result);
    try {
      await this.notifyPost(ctx.run.id);
    } catch (hookError) {
      this.deps.agentRunRegistry.unregister(ctx.run.id);
      return {
        status: 403,
        body: { error: String(hookError), runId: ctx.run.id, taskId: ctx.task.id },
      };
    }
    this.deps.agentRunRegistry.unregister(ctx.run.id);
    return { status: 200, body: resultBody };
  }

  async prepare(
    body: unknown,
    makeChat?: LoopChatFn,
    callbacks?: AgentRequestCallbacks,
    completionContext?: AgentCompletionContext,
    execution?: AgentRequestExecutionOptions,
  ): Promise<{ error: ApiResult } | PreparedAgentRequest> {
    const parsed = agentConversationRequestBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return {
        error: {
          status: 400,
          body: { error: formatAgentRequestValidationError(parsed.error) },
        },
      };
    }
    const payload = parsed.data;
    const message = payload.message;
    if (payload.mode && !this.deps.agentRuntime.runPolicyManager.parseMode(payload.mode)) {
      return { error: { status: 400, body: { error: "mode 必须是 chat/plan/implement/debug/review" } } };
    }
    if (
      payload.permissionPolicy
      && !this.deps.agentRuntime.runPolicyManager.parsePermissionPolicy(payload.permissionPolicy)
    ) {
      return {
        error: {
          status: 400,
          body: {
            error: "permissionPolicy 必须是 readOnly/confirmBeforeEdit/autoEdit/confirmBeforeRun/autoRun",
          },
        },
      };
    }
    const resolvedPolicy = await this.deps.agentRuntime.runPolicyManager.resolveAsync({
      requestedMode: payload.mode,
      forceMode: payload.mode !== undefined || payload.forceMode === true,
      sessionId: payload.sessionId,
      requestedPermissionPolicy: payload.permissionPolicy,
      autoConfirm: payload.autoConfirm,
      budget: payload.budget,
      taskType: payload.taskType,
      message,
    });
    const handoffPermissionCeiling =
      execution?.permissionCeiling ?? execution?.grantedPermissions;
    let policy = handoffPermissionCeiling
      ? {
          ...resolvedPolicy,
          allowedPermissions: resolvedPolicy.allowedPermissions.filter((permission) =>
            handoffPermissionCeiling.includes(permission)),
        }
      : resolvedPolicy;
    let effectiveHandoffPermissions = handoffPermissionCeiling
      ? [...policy.allowedPermissions]
      : undefined;
    let effectiveRunGrantedPermissions = execution?.grantedPermissions
      ? execution.grantedPermissions.filter((permission) =>
          policy.allowedPermissions.includes(permission))
      : undefined;
    if (handoffPermissionCeiling && policy.allowedPermissions.length === 0) {
      return {
        error: {
          status: 400,
          body: { error: "Agent 临时授权与用户权限边界没有交集" },
        },
      };
    }

    const persist = payload.persist !== false;
    const requestedProjectId = this.optionalTrimmed(payload.projectId);
    const requestedWorkspaceKey = this.optionalTrimmed(payload.workspaceKey);
    const sessionId = persist
      ? this.deps.sessionWorkspace.ensureSession(
          payload.sessionId,
          "智能体会话",
          requestedWorkspaceKey,
          requestedProjectId,
        )
      : undefined;
    const projectId = this.deps.sessionWorkspace.projectIdForSession(
      sessionId,
      requestedProjectId ?? requestedWorkspaceKey,
    );
    const pauseGate = findBlockingAgentPause({
      sessionId,
      planHandoffStore: this.deps.planHandoffStore,
      permissionRequestStore: this.deps.permissionRequestStore,
      pausedRunStore: this.deps.pausedRunStore,
    });
    if (pauseGate) {
      return {
        error: {
          status: 409,
          body: {
            error: pauseGate.error,
            code: pauseGate.code,
            planHandoff: pauseGate.planHandoff,
            permissionRequest: pauseGate.permissionRequest,
            runId: pauseGate.runId,
          },
        },
      };
    }

    const task = execution?.taskBinding === "detached"
      ? this.deps.taskService.createDetachedTask(sessionId, message.slice(0, 500))
      : this.deps.taskService.resolveOrCreateTask(sessionId, message.slice(0, 500));
    const createdRun = this.deps.runs.execute({
      type: "run.create",
      kind: "agent",
      sessionId,
      taskId: task.id,
      goal: message.slice(0, 200),
      parentRunId: execution?.parentRunId,
      causationId: execution?.authorization
        ? `agent-proposal:${execution.authorization.proposalId}`
        : undefined,
    });
    const hook = await this.deps.hooks?.dispatch({
      event: "run.pre",
      eventId: createdRun.id,
      payload: {
        runId: createdRun.id,
        kind: "agent",
        sessionId,
        taskId: task.id,
      },
      authority: {
        permissions: policy.allowedPermissions,
        timeoutMs: policy.budget.maxRuntimeMs,
      },
    });
    if (hook && !hook.allowed) {
      this.deps.runs.execute({
        type: "run.fail",
        runId: createdRun.id,
        expectedAggregateVersion: createdRun.aggregateVersion,
        error: hook.reason ?? "run_hook_rejected",
      });
      await this.notifyPost(createdRun.id);
      return {
        error: {
          status: 403,
          body: {
            error: hook.reason ?? "run_hook_rejected",
            runId: createdRun.id,
            taskId: task.id,
          },
        },
      };
    }
    if (hook) {
      policy = {
        ...policy,
        allowedPermissions: policy.allowedPermissions.filter((permission) =>
          hook.authority.permissions.includes(permission)),
        budget: {
          ...policy.budget,
          maxRuntimeMs: Math.min(policy.budget.maxRuntimeMs, hook.authority.timeoutMs),
        },
      };
      effectiveHandoffPermissions = effectiveHandoffPermissions?.filter((permission) =>
        hook.authority.permissions.includes(permission));
      effectiveRunGrantedPermissions = effectiveRunGrantedPermissions?.filter((permission) =>
        hook.authority.permissions.includes(permission));
    }
    const run = this.deps.runs.execute({
      type: "run.start",
      runId: createdRun.id,
      expectedAggregateVersion: createdRun.aggregateVersion,
    });
    let registeredForCancel = false;
    try {
      let cancelSignal: AbortSignal | undefined;
      if (callbacks?.registerForCancel) {
        cancelSignal = this.deps.agentRunRegistry.register(run.id, "agent").signal;
        registeredForCancel = true;
      }
      const workspaceRoot = this.deps.sessionWorkspace.workspaceForSession(sessionId);
      const timeline = callbacks?.enableTimeline && sessionId
        ? new AgentTimelineService({
            projectRoot: workspaceRoot,
            storageRoot: this.deps.sessionWorkspace.activityRootForSession(sessionId),
            onEvent: callbacks.onActivityEvent,
          })
        : undefined;
      timeline?.createRun({
        id: run.id,
        goal: message,
        sessionId,
        metadata: {
          userInput: message,
          mode: policy.mode,
          projectRoot: workspaceRoot,
          ...(execution?.authorization
            ? {
                agentProposalId: execution.authorization.proposalId,
                agentGrantId: execution.authorization.grantId,
              }
            : {}),
        },
      });

      const engine = this.deps.executionEngines.create({
        chat: makeChat ?? this.deps.makeChatFn(),
        autoConfirm: payload.autoConfirm ?? false,
        sensitive: payload.sensitive,
        taskType: payload.taskType,
        policy,
        allowedPermissions: effectiveHandoffPermissions,
        runGrantedPermissions: effectiveRunGrantedPermissions,
        handoffAuthorization: execution?.authorization,
        persistContext: persist,
        sessionId,
        projectId,
        runId: run.id,
        taskId: task.id,
        onStep: callbacks?.onStep,
        onModelTurn: callbacks?.onModelTurn,
        onToken: callbacks?.onToken,
        signal: cancelSignal,
        timeline,
        pauseOnPermissionRequest: execution?.pauseOnPermissionRequest ?? true,
        skipPlanHandoff: payload.skipPlanHandoff === true,
        completionCriteria: completionContext?.completionCriteria,
      });

      return { ctx: { message, system: payload.system, sessionId, task, run, engine } };
    } catch (error) {
      if (registeredForCancel) this.deps.agentRunRegistry.unregister(run.id);
      return {
        error: {
          status: 502,
          body: this.deps.agentRunLifecycle.finalizeFailure({ sessionId, task, run }, error),
        },
      };
    }
  }

  async notifyPost(runId: string): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    const post = await this.deps.hooks?.dispatch({
      event: "run.post",
      eventId: runId,
      payload: {
        runId,
        kind: run.kind,
        status: run.status,
        sessionId: run.sessionId,
        taskId: run.taskId,
      },
      authority: { permissions: [], timeoutMs: 5_000 },
    });
    if (post && !post.allowed) {
      throw new Error(post.reason ?? "run_post_hook_rejected");
    }
  }

  private optionalTrimmed(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }
}
