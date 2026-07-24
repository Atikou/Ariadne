import type { ToolPermission } from "../core/permissions.js";

import type { AgentRunMode } from "./RunPolicyTypes.js";

import type { WorkflowRouteResult } from "./WorkflowRouter.js";

import type { UserPermissionPolicy } from "./RunPolicyTypes.js";

import { isHardWorkflow, isSoftWorkflow } from "./WorkflowRouter.js";



export type WorkflowBlockKind = "readonly_mode_blocked" | "workflow_capability_denied";



export interface WorkflowCapabilities {

  allowRead: boolean;

  allowWrite: boolean;

  allowShell: boolean;

  allowNetwork: boolean;

  allowDangerous: boolean;

}



export interface WorkflowCapabilityAssessment {

  blocked: boolean;

  outcomeKind?: WorkflowBlockKind;

  blockedReasonKind?: "workflow";

  reason?: string;

}



/** 工作流默认预期能力（非 soft workflow 的硬权限上限）。 */

export function workflowCapabilitiesFromRoute(

  route: Pick<WorkflowRouteResult, "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind">,

): WorkflowCapabilities {

  if (route.readonlyOnly || route.enforceReadOnlyTools) {

    return {

      allowRead: true,

      allowWrite: false,

      allowShell: false,

      allowNetwork: false,

      allowDangerous: false,

    };

  }

  return {

    allowRead: true,

    allowWrite: route.sideEffectKind === "write" || route.sideEffectKind === "mixed",

    allowShell: route.sideEffectKind === "shell" || route.sideEffectKind === "mixed",

    allowNetwork: true,

    allowDangerous: true,

  };

}



export function capabilitiesToPermissions(caps: WorkflowCapabilities): ToolPermission[] {

  const out: ToolPermission[] = [];

  if (caps.allowRead) out.push("read");

  if (caps.allowWrite) out.push("write");

  if (caps.allowShell) out.push("shell");

  if (caps.allowNetwork) out.push("network");

  if (caps.allowDangerous) out.push("dangerous");

  return out;

}



export function permissionsForPolicy(policy: UserPermissionPolicy): ToolPermission[] {

  switch (policy) {

    case "readOnly":

      return ["read"];

    case "confirmBeforeEdit":

    case "autoEdit":

      return ["read", "write"];

    case "confirmBeforeRun":

    case "autoRun":

      return ["read", "write", "shell", "network", "dangerous"];

  }

}



/**

 * hardWorkflow：用户策略 ∩ 工作流硬能力；

 * softWorkflow：仅用户策略（工作流默认能力仅作 escalation 依据）。

 */

export function resolveAllowedPermissions(

  workflowRoute: Pick<

    WorkflowRouteResult,

    "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"

  >,

  permissionPolicy: UserPermissionPolicy,

): ToolPermission[] {

  const policyPerms = permissionsForPolicy(permissionPolicy);

  if (isSoftWorkflow(workflowRoute)) {

    return [...policyPerms];

  }



  const workflowCaps = capabilitiesToPermissions(workflowCapabilitiesFromRoute(workflowRoute));

  const policySet = new Set(policyPerms);

  return workflowCaps.filter((p) => {

    if (policySet.has(p)) return true;

    if (

      (p === "shell" || p === "network") &&

      (permissionPolicy === "confirmBeforeEdit" ||

        permissionPolicy === "autoEdit" ||

        permissionPolicy === "confirmBeforeRun")

    ) {

      return true;

    }

    return false;

  });

}



function isReadonlyMode(mode: AgentRunMode): boolean {

  return mode === "review" || mode === "plan" || mode === "chat";

}



/**

 * hardWorkflow：超出默认能力则硬阻断；

 * softWorkflow：不阻断，交由 CapabilityEscalation + PermissionGuard。

 */

export function assessWorkflowToolAccess(input: {

  mode: AgentRunMode;

  workflowRoute: Pick<

    WorkflowRouteResult,

    "workflowKind" | "readonlyOnly" | "enforceReadOnlyTools" | "sideEffectKind"

  >;

  toolPermission?: ToolPermission;

}): WorkflowCapabilityAssessment {

  if (!input.toolPermission || input.toolPermission === "read") {

    return { blocked: false };

  }



  if (isSoftWorkflow(input.workflowRoute)) {

    return { blocked: false };

  }



  const caps = workflowCapabilitiesFromRoute(input.workflowRoute);

  const allowed =

    input.toolPermission === "write" || input.toolPermission === "dangerous"

      ? caps.allowWrite

      : input.toolPermission === "shell"

        ? caps.allowShell

        : input.toolPermission === "network"

          ? caps.allowNetwork

          : caps.allowDangerous;



  if (allowed) return { blocked: false };



  const readonlyBlocked = input.workflowRoute.readonlyOnly && isReadonlyMode(input.mode);

  return {

    blocked: true,

    blockedReasonKind: "workflow",

    outcomeKind: readonlyBlocked ? "readonly_mode_blocked" : "workflow_capability_denied",

    reason: readonlyBlocked

      ? `当前 ${input.mode} 为只读工作流，不允许 ${input.toolPermission} 操作；请改用只读工具或直接输出 final。`

      : `当前工作流不允许 ${input.toolPermission} 操作；请调整任务类型或使用只读工具。`,

  };

}
