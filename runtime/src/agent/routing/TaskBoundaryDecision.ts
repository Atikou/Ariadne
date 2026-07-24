import type { AgentWorkflowType } from "../IntentTypes.js";
import type { SideEffectKind } from "../completion/TaskCompletionContract.js";
import { inferRequiredSideEffectsFromMessage } from "./SideEffectInference.js";
import { softWorkflowCanSatisfySideEffects } from "../CapabilityEscalation.js";
import { workflowCapabilitiesFromRoute } from "../WorkflowCapability.js";
import { defaultWorkflowRouter } from "../WorkflowRouter.js";
import type { TaskContext } from "../task/TaskContext.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";

export interface TaskBoundaryDecision {
  hasExplicitActionAnchor: boolean;
  requiredSideEffects: SideEffectKind[];
  breaksContinuation: boolean;
  reason: string;
}

export function workflowSatisfiesSideEffects(
  workflowType: AgentWorkflowType,
  requiredSideEffects: SideEffectKind[],
): boolean {
  if (requiredSideEffects.length === 0) return true;
  const route = defaultWorkflowRouter.routeWorkflowType(workflowType);
  if (!route) return false;
  if (softWorkflowCanSatisfySideEffects(route)) return true;
  return workflowDirectlyAllowsSideEffects(workflowType, requiredSideEffects);
}

/** 当前 workflow 硬能力是否直接覆盖所需副作用（不含 soft escalation 预期）。 */
export function workflowDirectlyAllowsSideEffects(
  workflowType: AgentWorkflowType,
  requiredSideEffects: SideEffectKind[],
): boolean {
  if (requiredSideEffects.length === 0) return true;
  const route = defaultWorkflowRouter.routeWorkflowType(workflowType);
  if (!route) return false;
  const caps = workflowCapabilitiesFromRoute(route);
  for (const kind of requiredSideEffects) {
    if (kind === "read") continue;
    if (kind === "write" && !caps.allowWrite) return false;
    if (kind === "shell" && !caps.allowShell) return false;
  }
  return true;
}

function isContinuationRefinementOnly(
  signals: MessageContinuationSignals,
  requiredSideEffects: SideEffectKind[],
): boolean {
  if (requiredSideEffects.includes("shell")) return false;
  if (!signals.isShortUtterance || !signals.hasAnaphora) return false;
  return requiredSideEffects.length === 0 || requiredSideEffects.includes("write");
}

/**
 * 任务边界：当前消息是否提出与活跃任务 workflow 不兼容的新操作目标。
 * 不直接映射 workflow，仅判断 requiredSideEffects 与继承候选是否兼容。
 */
export function evaluateTaskBoundary(
  message: string,
  ctx: TaskContext | undefined,
  signals: MessageContinuationSignals,
): TaskBoundaryDecision {
  const goal = message.trim();
  const requiredSideEffects = inferRequiredSideEffectsFromMessage(goal, signals);
  const hasExplicitActionAnchor =
    requiredSideEffects.length > 0 && !isContinuationRefinementOnly(signals, requiredSideEffects);

  if (!ctx?.isActive || !hasExplicitActionAnchor) {
    return {
      hasExplicitActionAnchor,
      requiredSideEffects,
      breaksContinuation: false,
      reason: hasExplicitActionAnchor
        ? "无活跃任务或无需打断继承"
        : "未检测到与副作用不兼容的显式操作锚点",
    };
  }

  if (workflowDirectlyAllowsSideEffects(ctx.workflowType, requiredSideEffects)) {
    return {
      hasExplicitActionAnchor,
      requiredSideEffects,
      breaksContinuation: false,
      reason: "活跃 workflow 可直接满足当前任务所需副作用",
    };
  }

  const route = defaultWorkflowRouter.routeWorkflowType(ctx.workflowType);
  if (
    route &&
    softWorkflowCanSatisfySideEffects(route) &&
    !requiredSideEffects.includes("shell")
  ) {
    return {
      hasExplicitActionAnchor,
      requiredSideEffects,
      breaksContinuation: false,
      reason: "soft workflow 可通过 escalation 满足 write，续写不打断",
    };
  }

  const missing = requiredSideEffects.filter((kind) => {
    if (kind === "read") return false;
    return !workflowDirectlyAllowsSideEffects(ctx.workflowType, [kind]);
  });

  return {
    hasExplicitActionAnchor,
    requiredSideEffects,
    breaksContinuation: true,
    reason: `当前任务需要 ${missing.join("/")}，不能继承 ${ctx.workflowType}`,
  };
}
