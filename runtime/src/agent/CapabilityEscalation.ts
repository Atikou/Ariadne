import type { ToolPermission } from "../core/permissions.js";
import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import {
  capabilitiesToPermissions,
  workflowCapabilitiesFromRoute,
} from "./WorkflowCapability.js";
import {
  defaultWorkflowRouter,
  isHardWorkflow,
  isSoftWorkflow,
  type WorkflowRouteResult,
} from "./WorkflowRouter.js";

export interface CapabilityEscalation {
  fromWorkflow: AgentWorkflowType;
  fromIntent: AgentIntentType;
  toWorkflow: AgentWorkflowType;
  toIntent: AgentIntentType;
  requestedTool: string;
  requestedPermission: ToolPermission;
  currentExpectedSideEffects: ToolPermission[];
  targetSideEffects: ToolPermission[];
  canEscalate: boolean;
  reason: string;
}

export interface CapabilityEscalationRecord extends CapabilityEscalation {
  iteration: number;
  applied: boolean;
}

/** 工作流默认预期副作用（用于 escalation 判断，非硬权限）。 */
export function expectedSideEffectsFromRoute(
  route: Pick<WorkflowRouteResult, "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind">,
): ToolPermission[] {
  return capabilitiesToPermissions(workflowCapabilitiesFromRoute(route));
}

export function permissionWithinExpected(
  route: Pick<WorkflowRouteResult, "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind">,
  permission: ToolPermission | undefined,
): boolean {
  if (!permission || permission === "read") return true;
  const caps = workflowCapabilitiesFromRoute(route);
  if (permission === "write" || permission === "dangerous") return caps.allowWrite;
  if (permission === "shell") return caps.allowShell;
  if (permission === "network") return caps.allowNetwork;
  return caps.allowDangerous;
}

function mergeTargetSideEffects(
  route: Pick<WorkflowRouteResult, "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind">,
  requested: ToolPermission,
): ToolPermission[] {
  const current = new Set(expectedSideEffectsFromRoute(route));
  current.add("read");
  if (requested === "write" || requested === "dangerous") {
    current.add("write");
    current.add("dangerous");
  } else if (requested === "shell") {
    current.add("shell");
  } else if (requested === "network") {
    current.add("network");
  } else {
    current.add(requested);
  }
  const order: ToolPermission[] = ["read", "write", "shell", "network", "dangerous"];
  return order.filter((p) => current.has(p));
}

/** 将超出默认能力的工具请求映射到 reconciled intent（仅 soft workflow）。 */
export function resolveEscalationTarget(
  route: WorkflowRouteResult,
  requested: ToolPermission,
): WorkflowRouteResult {
  const needsWrite = requested === "write" || requested === "dangerous";
  const needsShell = requested === "shell";
  const current = route.sideEffectKind;

  if (needsWrite && current === "shell") {
    return defaultWorkflowRouter.routeIntent("debug");
  }
  if (needsWrite) {
    return defaultWorkflowRouter.routeIntent("edit");
  }
  if (needsShell && current === "write") {
    return defaultWorkflowRouter.routeIntent("debug");
  }
  if (needsShell) {
    return defaultWorkflowRouter.routeIntent("run");
  }
  return defaultWorkflowRouter.routeIntent("debug");
}

function escalationReason(
  route: WorkflowRouteResult,
  target: WorkflowRouteResult,
  toolName: string,
  requested: ToolPermission,
): string {
  return [
    `${route.workflowType} 中模型请求 ${toolName}（${requested}）`,
    `超出默认预期副作用 [${expectedSideEffectsFromRoute(route).join(", ") || "read"}]；`,
    `任务需升级为 ${target.workflowType}（${target.intent}）后继续，由 PermissionGuard 与用户策略决定是否执行。`,
  ].join("");
}

/**
 * soft workflow 中工具能力超出默认预期时，返回可升级的 reconcile 计划；
 * hard workflow 返回 undefined（由 WorkflowCapability 硬阻断）。
 */
export function evaluateCapabilityEscalation(input: {
  workflowRoute: WorkflowRouteResult;
  toolName: string;
  toolPermission?: ToolPermission;
}): CapabilityEscalation | undefined {
  const permission = input.toolPermission;
  if (!permission || permission === "read") return undefined;
  if (isHardWorkflow(input.workflowRoute)) return undefined;
  if (permissionWithinExpected(input.workflowRoute, permission)) return undefined;

  const target = resolveEscalationTarget(input.workflowRoute, permission);
  return {
    fromWorkflow: input.workflowRoute.workflowType,
    fromIntent: input.workflowRoute.intent,
    toWorkflow: target.workflowType,
    toIntent: target.intent,
    requestedTool: input.toolName,
    requestedPermission: permission,
    currentExpectedSideEffects: expectedSideEffectsFromRoute(input.workflowRoute),
    targetSideEffects: mergeTargetSideEffects(input.workflowRoute, permission),
    canEscalate: true,
    reason: escalationReason(input.workflowRoute, target, input.toolName, permission),
  };
}

export function renderCapabilityEscalationContext(escalation: CapabilityEscalation): string {
  return [
    "[Capability escalation]",
    `Task was classified as ${escalation.fromWorkflow} (${escalation.fromIntent}),`,
    `but the agent requested ${escalation.requestedTool} (${escalation.requestedPermission}).`,
    escalation.reason,
    `Reconciled workflow: ${escalation.toWorkflow} (${escalation.toIntent}).`,
    "Proceed with PermissionGuard and user permission policy for the actual tool execution.",
  ].join(" ");
}

/** soft workflow 是否可通过动态升级满足所需副作用（用于任务续写边界）。 */
export function softWorkflowCanSatisfySideEffects(
  route: Pick<WorkflowRouteResult, "workflowKind">,
): boolean {
  return isSoftWorkflow(route);
}
