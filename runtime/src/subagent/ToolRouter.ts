import type { ToolPermission } from "../core/permissions.js";
import {
  ALL_PERMISSIONS,
  assertUserGrantWithinCeiling,
  resolveEffectivePermissions,
} from "../policy/PermissionPolicy.js";
import type { DelegatedTaskToolPolicy } from "./delegatedTask.js";
import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";

const DANGEROUS_TOOLS = new Set([
  "shell_run",
  "write_file",
  "apply_patch",
  DISPATCH_SUBAGENT_TOOL_NAME,
]);

/** 根据任务 toolPolicy 解析有效工具权限与允许的工具名列表。 */
export class ToolRouter {
  resolvePermissions(
    policy: DelegatedTaskToolPolicy,
    requested?: ToolPermission[],
    projectAllowed: ToolPermission[] = ALL_PERMISSIONS,
  ): { permissions: ToolPermission[]; allowedToolNames: Set<string> } {
    const ceiling = toolPolicyPermissionCeiling(policy);

    // 副作用子任务必须由父 Agent 显式授予对应权限；模型协议没有审批开关，
    // grantedPermissions 缺省时也不能放行写/命令。
    if (policy.writeAllowed && !(requested && requested.includes("write"))) {
      throw new Error("写权限子任务须由父 Agent 显式授予 grantedPermissions 含 write");
    }
    if (policy.shellAllowed && !(requested && requested.includes("shell"))) {
      throw new Error("shell 子任务须由父 Agent 显式授予 grantedPermissions 含 shell");
    }

    if (requested) {
      assertUserGrantWithinCeiling(requested, ceiling, "子任务 toolPolicy");
    }

    const resolved = resolveEffectivePermissions({
      projectAllowed,
      modeAllowed: ALL_PERMISSIONS,
      modeSource: "subagent.delegated",
      roleAllowed: ceiling,
      roleSource: "subagent.toolPolicy",
      userGranted: requested,
      userSource: "subagent.grantedPermissions",
      strictUserGrant: requested != null,
    });

    const permissions =
      resolved.allowed.length > 0 ? resolved.allowed : ceiling.filter((p) => p === "read" || (policy.writeAllowed && p === "write"));

    const allowedToolNames = new Set(policy.allowedTools);
    if (!policy.writeAllowed) {
      for (const name of ["write_file", "apply_patch", "backup_file", "rollback_change"]) {
        allowedToolNames.delete(name);
      }
    }
    if (!policy.shellAllowed) {
      allowedToolNames.delete("shell_run");
    }
    allowedToolNames.delete(DISPATCH_SUBAGENT_TOOL_NAME);

    return { permissions, allowedToolNames };
  }

  isToolAllowed(toolName: string, allowed: Set<string>): boolean {
    if (DANGEROUS_TOOLS.has(toolName) && !allowed.has(toolName)) {
      return false;
    }
    return allowed.has(toolName);
  }
}

export const defaultToolRouter = new ToolRouter();

/** batch 父授权是任务并集；协调器下传前按单任务 ceiling 收窄。 */
export function intersectBatchPermissionsWithToolPolicy(
  policy: DelegatedTaskToolPolicy,
  batchPermissions: readonly ToolPermission[] | undefined,
): ToolPermission[] | undefined {
  if (!batchPermissions) return undefined;
  const ceiling = toolPolicyPermissionCeiling(policy);
  return batchPermissions.filter((permission) => ceiling.includes(permission));
}

function toolPolicyPermissionCeiling(policy: DelegatedTaskToolPolicy): ToolPermission[] {
  const ceiling: ToolPermission[] = ["read"];
  if (policy.writeAllowed) ceiling.push("write");
  if (policy.shellAllowed) ceiling.push("shell");
  return ceiling;
}
