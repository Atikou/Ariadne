import { AgentLoop, type AgentLoopOptions } from "../agent/AgentLoop.js";

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
  sessionPermissionGrants?: AgentLoopOptions["sessionPermissionGrants"];
  workspaceGrantStore?: AgentLoopOptions["workspaceGrantStore"];
  pausedRunStore?: AgentLoopOptions["pausedRunStore"];
  shellPolicy?: AgentLoopOptions["shellPolicy"];
  networkPolicy?: AgentLoopOptions["networkPolicy"];
  resolveInstructions?: AgentLoopOptions["resolveInstructions"];
}

export interface AgentLoopCreationRequest {
  chat: AgentLoopOptions["chat"];
  runId: string;
  sessionId?: string;
  taskId?: string;
  projectId: string;
  persistContext: boolean;
  autoConfirm?: AgentLoopOptions["autoConfirm"];
  sensitive?: AgentLoopOptions["sensitive"];
  taskType?: AgentLoopOptions["taskType"];
  policy?: AgentLoopOptions["policy"];
  allowedPermissions?: AgentLoopOptions["allowedPermissions"];
  runGrantedPermissions?: AgentLoopOptions["runGrantedPermissions"];
  handoffAuthorization?: AgentLoopOptions["handoffAuthorization"];
  resumeState?: AgentLoopOptions["resumeState"];
  pausedRun?: AgentLoopOptions["pausedRun"];
  scopedGrants?: AgentLoopOptions["scopedGrants"];
  pauseOnPermissionRequest?: AgentLoopOptions["pauseOnPermissionRequest"];
  onStep?: AgentLoopOptions["onStep"];
  onModelTurn?: AgentLoopOptions["onModelTurn"];
  onToken?: AgentLoopOptions["onToken"];
  signal?: AgentLoopOptions["signal"];
  timeline?: AgentLoopOptions["timeline"];
  skipPlanHandoff?: AgentLoopOptions["skipPlanHandoff"];
  completionCriteria?: AgentLoopOptions["completionCriteria"];
}

export class AgentLoopFactory {
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
