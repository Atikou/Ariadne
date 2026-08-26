import { AgentLoop, type AgentLoopOptions } from "../agent/AgentLoop.js";
import type {
  AgentExecutionEngineFactory,
} from "./AgentExecutionEngineContracts.js";
import type { AgentExecutionEngineKind } from "./AgentExecutionIdentity.js";
import type { AgentLoopCreationRequest } from "./AgentLoopCreationContracts.js";

export type { AgentLoopCreationRequest } from "./AgentLoopCreationContracts.js";

export interface AgentLoopFactoryDeps {
  workspaceRoot: string;
  resolveWorkspaceRoot?: (sessionId?: string) => string;
  resolveWorkspaceConfigScopes?: (sessionId?: string) => AgentLoopOptions["workspaceConfigScopes"];
  registry: AgentLoopOptions["registry"];
  agentRuntime: NonNullable<AgentLoopOptions["agentRuntime"]>;
  contextManager: NonNullable<AgentLoopOptions["contextManager"]>;
  runStateStore: NonNullable<AgentLoopOptions["runStateStore"]>;
  runRepository: NonNullable<AgentLoopOptions["runRepository"]>;
  projectIndex?: AgentLoopOptions["projectIndex"];
  notificationQueue: NonNullable<AgentLoopOptions["notificationQueue"]>;
  trace?: AgentLoopOptions["trace"];
  projectAllowedPermissions: NonNullable<AgentLoopOptions["projectAllowedPermissions"]>;
  maxCostUsdPerRun?: number;
  maxSubAgentDispatchDepth?: number;
  permissionRequestStore?: AgentLoopOptions["permissionRequestStore"];
  planHandoffStore?: AgentLoopOptions["planHandoffStore"];
  agentPlanStore?: AgentLoopOptions["agentPlanStore"];
  sessionPermissionGrants?: AgentLoopOptions["sessionPermissionGrants"];
  workspaceGrantStore?: AgentLoopOptions["workspaceGrantStore"];
  pausedRunStore?: AgentLoopOptions["pausedRunStore"];
  shellPolicy?: AgentLoopOptions["shellPolicy"];
  networkPolicy?: AgentLoopOptions["networkPolicy"];
  resolveInstructions?: AgentLoopOptions["resolveInstructions"];
}

export class AgentLoopFactory implements AgentExecutionEngineFactory {
  readonly kind: AgentExecutionEngineKind = "react_loop";

  constructor(private readonly deps: AgentLoopFactoryDeps) {}

  create(request: AgentLoopCreationRequest): AgentLoop {
    return new AgentLoop(buildAgentLoopOptions(this.deps, request));
  }
}

export function buildAgentLoopOptions(
  deps: AgentLoopFactoryDeps,
  request: AgentLoopCreationRequest,
): AgentLoopOptions {
  return {
    chat: request.chat,
    registry: deps.registry,
    agentRuntime: deps.agentRuntime,
    workspaceRoot: deps.resolveWorkspaceRoot?.(request.sessionId) ?? deps.workspaceRoot,
    autoConfirm: request.autoConfirm,
    sensitive: request.sensitive,
    taskType: request.taskType,
    policy: request.policy,
    allowedPermissions: request.allowedPermissions,
    runGrantedPermissions: request.runGrantedPermissions,
    handoffAuthorization: request.handoffAuthorization,
    projectAllowedPermissions: deps.projectAllowedPermissions,
    trace: deps.trace,
    notificationQueue: deps.notificationQueue,
    contextManager: request.persistContext ? deps.contextManager : undefined,
    sessionId: request.sessionId,
    projectId: request.projectId,
    runId: request.runId,
    taskId: request.taskId,
    requestId: request.runId,
    runStateStore: deps.runStateStore,
    runRepository: deps.runRepository,
    projectIndex: deps.projectIndex,
    resumeState: request.resumeState,
    permissionRequestStore: deps.permissionRequestStore,
    planHandoffStore: deps.planHandoffStore,
    agentPlanStore: deps.agentPlanStore,
    sessionPermissionGrants: deps.sessionPermissionGrants,
    workspaceGrantStore: deps.workspaceGrantStore,
    workspaceConfigScopes: deps.resolveWorkspaceConfigScopes?.(request.sessionId) ?? [],
    pausedRunStore: deps.pausedRunStore,
    pausedRun: request.pausedRun,
    scopedGrants: request.scopedGrants,
    pauseOnPermissionRequest: request.pauseOnPermissionRequest,
    maxCostUsdPerRun: deps.maxCostUsdPerRun,
    subAgentDispatchDepth: 0,
    maxSubAgentDispatchDepth: deps.maxSubAgentDispatchDepth ?? 1,
    shellPolicy: deps.shellPolicy,
    networkPolicy: deps.networkPolicy,
    resolveInstructions: deps.resolveInstructions,
    signal: request.signal,
    timeline: request.timeline,
    onStep: request.onStep,
    onModelTurn: request.onModelTurn,
    onToken: request.onToken,
    skipPlanHandoff: request.skipPlanHandoff,
    completionCriteria: request.completionCriteria,
  };
}
