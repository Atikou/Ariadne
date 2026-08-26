import type { ModelTaskType } from "../model/taskType.js";
import type { LoopChatFn } from "../model-router/agent-chat-types.js";
import type { CompletionCriterionInput } from "../agent/completion/CompletionContracts.js";
import type { AgentModelTurnEvent } from "../agent/AgentModelTurn.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import type { AgentTimelineService } from "../agent/timeline/AgentTimelineService.js";
import type {
  AgentHandoffAuthorizationContext,
  PausedRunSnapshot,
} from "../agent/PausedRunStore.js";
import type { RunPolicy } from "../agent/RunPolicyContracts.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ScopedApprovedPermissions } from "../policy/permissionRequestTypes.js";
import type { RunState } from "./runStateTypes.js";

export interface AgentLoopCreationRequest {
  chat: LoopChatFn;
  runId: string;
  sessionId?: string;
  taskId?: string;
  projectId: string;
  persistContext: boolean;
  autoConfirm?: boolean;
  sensitive?: boolean;
  taskType?: ModelTaskType;
  policy?: RunPolicy;
  allowedPermissions?: ToolPermission[];
  runGrantedPermissions?: ToolPermission[];
  handoffAuthorization?: AgentHandoffAuthorizationContext;
  resumeState?: RunState;
  pausedRun?: PausedRunSnapshot;
  scopedGrants?: ScopedApprovedPermissions;
  pauseOnPermissionRequest?: boolean;
  onStep?: (step: AgentToolStep) => void;
  onModelTurn?: (turn: AgentModelTurnEvent) => void;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  timeline?: AgentTimelineService;
  skipPlanHandoff?: boolean;
  completionCriteria?: readonly CompletionCriterionInput[];
}
