import type { ToolPermission } from "../core/permissions.js";
import type { LoopChatFn } from "../model-router/agent-chat-types.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentRunnerPort } from "../agent/AgentRunResultContracts.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import type { AgentRunMode, RunBudget } from "../agent/RunPolicyPrimitives.js";

export interface SubAgentRunnerCreationRequest {
  chat: LoopChatFn;
  registry: ToolRegistry;
  workspaceRoot: string;
  processSandbox?: ProcessSandbox;
  projectAllowedPermissions?: ToolPermission[];
  roleAllowedPermissions: ToolPermission[];
  allowedPermissions: ToolPermission[];
  runGrantedPermissions: ToolPermission[];
  allowedToolNames: readonly string[];
  budget: RunBudget;
  mode: AgentRunMode;
  permissionPolicy: string;
  autoConfirm: false;
  sensitive?: boolean;
  trace?: TraceLogger;
  subAgentDispatchDepth: number;
  maxSubAgentDispatchDepth: number;
  maxCostUsdPerRun?: number;
  signal?: AbortSignal;
  onStep?: (step: AgentToolStep) => void;
}

export interface SubAgentRunnerFactoryPort {
  create(request: SubAgentRunnerCreationRequest): AgentRunnerPort;
}
