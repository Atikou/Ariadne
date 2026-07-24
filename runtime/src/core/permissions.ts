/**
 * 权限与模式边界（共享词汇，置于 core/ 最底层）。
 *
 * ToolPermission 既用于计划步骤声明所需权限，也被工具系统 / 策略层 / 子 Agent 复用。
 * 放在 core/ 而非 agent/，避免 policy/、tools/、plan/ 等较低层反向 import 执行层 agent/。
 */
export const TOOL_PERMISSION_VALUES = [
  "read",
  "write",
  "shell",
  "network",
  "dangerous",
] as const;

export type ToolPermission = (typeof TOOL_PERMISSION_VALUES)[number];

export const ALL_PERMISSIONS: ToolPermission[] = [...TOOL_PERMISSION_VALUES];

/** TaskRunner / 计划步骤声明用的二值权限轮廓（非 AgentRunMode）。 */
export type TaskRunnerPermissionMode = "plan" | "task";

/** @deprecated 请使用 `TaskRunnerPermissionMode`；保留 plan/task 别名供 TaskRunner 边界。 */
export type AgentMode = TaskRunnerPermissionMode;

/** 各模式允许的权限边界。 */
export const MODE_PERMISSIONS: Record<TaskRunnerPermissionMode, ToolPermission[]> = {
  // 计划模式：只读分析，绝不修改文件或执行命令。
  plan: ["read"],
  // 任务模式：可读写、执行命令、联网；但 write/shell/network/dangerous 需经确认（见 needsConfirmation）。
  task: ["read", "write", "shell", "network", "dangerous"],
};

/** 默认需要用户确认的高风险权限。 */
export const CONFIRMATION_REQUIRED: ToolPermission[] = ["write", "shell", "network", "dangerous"];

export function isPermissionAllowed(mode: TaskRunnerPermissionMode, permission: ToolPermission): boolean {
  return MODE_PERMISSIONS[mode].includes(permission);
}

/** 这些权限里是否包含需要确认的项。 */
export function requiresConfirmation(permissions: ToolPermission[]): boolean {
  return permissions.some((p) => CONFIRMATION_REQUIRED.includes(p));
}
