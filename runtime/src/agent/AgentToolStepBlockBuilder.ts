import type { ToolPermission } from "../core/permissions.js";
import { buildPathConfirmationRequest } from "../policy/PathPolicy.js";
import type { ToolPathPreparation } from "../policy/PathPolicy.js";
import type { ToolAction } from "./AgentActionParser.js";
import type { AgentIntentType } from "./IntentTypes.js";
import type { RunBudgetKey, UserPermissionPolicy } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import type { WorkflowCapabilityAssessment } from "./WorkflowCapability.js";

export interface BlockedToolStepBase {
  action: ToolAction;
  iteration: number;
  toolCallId?: string;
  toolPermission?: ToolPermission;
}

/** 工作流能力层拒绝工具时构建 AgentToolStep。 */
export function buildWorkflowBlockedToolStep(
  input: BlockedToolStepBase & { block: WorkflowCapabilityAssessment },
): AgentToolStep {
  return {
    iteration: input.iteration,
    toolCallId: input.toolCallId,
    tool: input.action.tool,
    input: input.action.input ?? {},
    permission: input.toolPermission,
    thought: input.action.thought,
    ok: false,
    blocked: true,
    executed: false,
    blockedReasonKind: "workflow",
    outcomeClass: "execution_error",
    outcomeKind: input.block.outcomeKind ?? "policy_blocked",
    error: input.block.reason,
  };
}

/** PermissionGuard 拒绝工具时构建 AgentToolStep。 */
export function buildPermissionBlockedToolStep(
  input: BlockedToolStepBase & { reason: string },
): AgentToolStep {
  return {
    iteration: input.iteration,
    toolCallId: input.toolCallId,
    tool: input.action.tool,
    input: input.action.input ?? {},
    permission: input.toolPermission,
    thought: input.action.thought,
    ok: false,
    blocked: true,
    executed: false,
    blockedReasonKind: "permission",
    outcomeClass: "execution_error",
    outcomeKind: "permission_denied",
    error: input.reason,
  };
}

/** 分项预算耗尽时构建 AgentToolStep。 */
export function buildBudgetBlockedToolStep(
  input: BlockedToolStepBase & { budgetExhausted: RunBudgetKey },
): AgentToolStep {
  return {
    iteration: input.iteration,
    toolCallId: input.toolCallId,
    tool: input.action.tool,
    input: input.action.input ?? {},
    permission: input.toolPermission,
    thought: input.action.thought,
    ok: false,
    blocked: true,
    executed: false,
    blockedReasonKind: "budget",
    budgetExhausted: input.budgetExhausted,
    outcomeClass: "execution_error",
    outcomeKind: "budget_exhausted",
    error: `运行预算已耗尽：${input.budgetExhausted}`,
  };
}

/** 路径策略拒绝或需跨工作区确认时构建 AgentToolStep。 */
export function buildPathBlockedToolStep(
  input: BlockedToolStepBase & {
    pathAccess: ToolPathPreparation;
    intent: AgentIntentType;
    permissionPolicy: UserPermissionPolicy;
  },
): AgentToolStep {
  const confirmationRequest = input.pathAccess.decision.needsConfirmation
    ? buildPathConfirmationRequest({
        toolName: input.action.tool,
        decision: input.pathAccess.decision,
        intent: input.intent,
        permissionPolicy: input.permissionPolicy,
      })
    : undefined;
  return {
    iteration: input.iteration,
    toolCallId: input.toolCallId,
    tool: input.action.tool,
    input: input.action.input ?? {},
    permission: input.toolPermission,
    thought: input.action.thought,
    ok: false,
    blocked: true,
    executed: false,
    blockedReasonKind: input.pathAccess.decision.needsConfirmation ? "permission" : "policy",
    outcomeClass: "execution_error",
    outcomeKind: input.pathAccess.decision.needsConfirmation
      ? "permission_required"
      : "policy_blocked",
    error: input.pathAccess.decision.needsConfirmation
      ? `跨工作区访问需要用户授权：${input.pathAccess.decision.normalizedPath}`
      : `路径策略拒绝访问：${input.pathAccess.decision.reason}`,
    confirmationRequest,
    workspaceAccess: input.pathAccess.audit,
  };
}
