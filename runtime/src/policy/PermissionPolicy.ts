import {
  ALL_PERMISSIONS,
  CONFIRMATION_REQUIRED,
  MODE_PERMISSIONS,
  type ToolPermission,
} from "../core/permissions.js";
import type { Tool } from "../tools/types.js";

export {
  ALL_PERMISSIONS,
  CONFIRMATION_REQUIRED,
  MODE_PERMISSIONS,
  type ToolPermission,
};

/** 权限覆盖顺序：自外向内收窄，交集取最严（用户不可扩权）。 */
export const PERMISSION_SCOPE_ORDER = [
  "project",
  "mode",
  "role",
  "task",
  "user",
] as const;

export type PermissionScopeLevel = (typeof PERMISSION_SCOPE_ORDER)[number];

export interface PermissionScopeLayer {
  level: PermissionScopeLevel;
  /** 该层声明的允许集。 */
  allowed: ToolPermission[];
  /** 应用该层后与上层交集后的有效集。 */
  effective: ToolPermission[];
  source: string;
}

export interface ResolveEffectivePermissionsInput {
  /** 项目级上限；缺省为全部内置权限。 */
  projectAllowed?: ToolPermission[];
  projectSource?: string;
  /** 运行模式上限（如 plan/review 仅 read）。 */
  modeAllowed?: ToolPermission[];
  modeSource?: string;
  /** 子 Agent 角色上限。 */
  roleAllowed?: ToolPermission[];
  roleSource?: string;
  /** 任务级声明（TaskRunner / 步骤执行器传入）。 */
  taskAllowed?: ToolPermission[];
  taskSource?: string;
  /** 用户显式授予；只能收窄，不能超出已收敛上限。 */
  userGranted?: ToolPermission[];
  userSource?: string;
  /** true 时用户授予超出当前上限则抛错；false 时静默丢弃越权项。 */
  strictUserGrant?: boolean;
}

export interface EffectivePermissions {
  allowed: ToolPermission[];
  layers: PermissionScopeLayer[];
}

/** 工具是否需用户确认。 */
export function toolNeedsConfirmation(tool: Tool): boolean {
  return CONFIRMATION_REQUIRED.includes(tool.permission);
}

/** 权限是否在允许集内。 */
export function isPermissionAllowed(
  permission: ToolPermission,
  allowed: ToolPermission[],
): boolean {
  return allowed.includes(permission);
}

/** 按 ALL_PERMISSIONS 顺序求交集，保持稳定输出。 */
export function intersectPermissions(
  base: ToolPermission[],
  restrict: ToolPermission[],
): ToolPermission[] {
  const set = new Set(restrict);
  return ALL_PERMISSIONS.filter((p) => base.includes(p) && set.has(p));
}

/** 从配置解析项目级权限上限。 */
export function resolveProjectAllowedPermissions(
  config?: { allowed?: ToolPermission[] },
): ToolPermission[] {
  if (!config?.allowed || config.allowed.length === 0) return [...ALL_PERMISSIONS];
  return intersectPermissions(ALL_PERMISSIONS, config.allowed);
}

/** 校验用户授予是否为当前上限的子集。 */
export function assertUserGrantWithinCeiling(
  grant: ToolPermission[],
  ceiling: ToolPermission[],
  label = "用户授予",
): void {
  const invalid = grant.filter((p) => !ceiling.includes(p));
  if (invalid.length > 0) {
    throw new Error(`${label}超出允许范围：${invalid.join(", ")}`);
  }
}

/**
 * 按 project → mode → role → task → user 顺序收敛有效权限集。
 * 确认门、ShellPolicy、路径沙箱在工具执行阶段另行校验，不改变本函数的 allowed 集。
 */
export function resolveEffectivePermissions(
  input: ResolveEffectivePermissionsInput = {},
): EffectivePermissions {
  const layers: PermissionScopeLayer[] = [];
  let current = [...ALL_PERMISSIONS];

  const applyLayer = (
    level: PermissionScopeLevel,
    allowed: ToolPermission[] | undefined,
    source: string,
  ) => {
    if (!allowed || allowed.length === 0) {
      current = [];
      layers.push({ level, allowed: [], effective: [], source });
      return;
    }
    const next = intersectPermissions(current, allowed);
    layers.push({ level, allowed: [...allowed], effective: [...next], source });
    current = next;
  };

  applyLayer(
    "project",
    input.projectAllowed ?? ALL_PERMISSIONS,
    input.projectSource ?? "config.security.permissions",
  );

  if (input.modeAllowed) {
    applyLayer("mode", input.modeAllowed, input.modeSource ?? "run.mode");
  }
  if (input.roleAllowed) {
    applyLayer("role", input.roleAllowed, input.roleSource ?? "subagent.role");
  }
  if (input.taskAllowed) {
    applyLayer("task", input.taskAllowed, input.taskSource ?? "task.scope");
  }
  if (input.userGranted && input.userGranted.length > 0) {
    if (input.strictUserGrant) {
      assertUserGrantWithinCeiling(input.userGranted, current, "用户授予");
    }
    const grant = intersectPermissions(current, input.userGranted);
    applyLayer("user", grant, input.userSource ?? "user.grant");
  }

  return { allowed: current, layers };
}
