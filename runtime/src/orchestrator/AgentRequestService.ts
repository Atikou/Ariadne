import type { AgentLoop, LoopChatFn } from "../agent/AgentLoop.js";
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
import type { AgentLoopFactory } from "./AgentLoopFactory.js";
import type { AgentRunLifecycle } from "./AgentRunLifecycle.js";
import type { AgentRunRegistry } from "./AgentRunRegistry.js";
import type { RunStore } from "./RunStore.js";
import type { SessionWorkspaceResolver } from "./SessionWorkspaceResolver.js";
import type { TaskService } from "./TaskService.js";
import {
  agentConversationRequestBodySchema,
  formatAgentRequestValidationError,
} from "./AgentRequestSchemas.js";

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
    loop: AgentLoop;
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
  runs: RunStore;
  agentRunRegistry: AgentRunRegistry;
  agentLoopFactory: AgentLoopFactory;
  agentRunLifecycle: AgentRunLifecycle;
  makeChatFn: (forceClient?: string) => LoopChatFn;
  planHandoffStore?: PlanHandoffStore;
  permissionRequestStore?: PermissionRequestStore;
  pausedRunStore?: PausedRunStore;
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

    try {
      this.deps.agentRunLifecycle.traceStart(ctx);
      const result = await ctx.loop.run(ctx.message, ctx.system);
      return { status: 200, body: this.deps.agentRunLifecycle.finalizeSuccess(ctx, result) };
    } catch (error) {
      return { status: 502, body: this.deps.agentRunLifecycle.finalizeFailure(ctx, error) };
    } finally {
      this.deps.agentRunRegistry.unregister(ctx.run.id);
    }
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
    const policy = handoffPermissionCeiling
      ? {
          ...resolvedPolicy,
          allowedPermissions: resolvedPolicy.allowedPermissions.filter((permission) =>
            handoffPermissionCeiling.includes(permission)),
        }
      : resolvedPolicy;
    const effectiveHandoffPermissions = handoffPermissionCeiling
      ? [...policy.allowedPermissions]
      : undefined;
    const effectiveRunGrantedPermissions = execution?.grantedPermissions
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
    const run = this.deps.runs.create({
      kind: "agent",
      status: "running",
      sessionId,
      taskId: task.id,
      goal: message.slice(0, 200),
      parentRunId: execution?.parentRunId,
      correlation: {
        runId: "",
        sessionId,
        taskId: task.id,
        ...(execution?.authorization
          ? { requestId: `agent-proposal:${execution.authorization.proposalId}` }
          : {}),
      },
    });
    let registeredForCancel = false;
    try {
      this.deps.runs.update(run.id, {
        correlationJson: JSON.stringify({
          runId: run.id,
          sessionId,
          taskId: task.id,
          ...(execution?.authorization
            ? {
                requestId: `agent-proposal:${execution.authorization.proposalId}`,
                agentProposalId: execution.authorization.proposalId,
                agentGrantId: execution.authorization.grantId,
              }
            : {}),
        }),
      });

      let cancelSignal: AbortSignal | undefined;
      if (callbacks?.registerForCancel) {
        cancelSignal = this.deps.agentRunRegistry.register(run.id, "agent").signal;
        registeredForCancel = true;
      }
      const workspaceRoot = this.deps.sessionWorkspace.workspaceForSession(sessionId);
      const timeline = callbacks?.enableTimeline
        ? new AgentTimelineService({ workspaceRoot, onEvent: callbacks.onActivityEvent })
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

      const loop = this.deps.agentLoopFactory.create({
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

      return { ctx: { message, system: payload.system, sessionId, task, run, loop } };
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

  private optionalTrimmed(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }
}
