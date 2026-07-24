import type { ToolPermission } from "../core/permissions.js";
import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";

export const ENOUGH_SUBAGENT_RESULTS_FOR_FINAL = 3;

export interface SubagentToolAction {
  tool: string;
  input?: Record<string, unknown>;
}

export function countSuccessfulSubagentDispatches(steps: AgentToolStep[]): number {
  return steps.filter((step) => step.tool === DISPATCH_SUBAGENT_TOOL_NAME && isSuccessfulToolStep(step)).length;
}

export function assessSubagentDispatchGuard(action: SubagentToolAction, steps: AgentToolStep[]): string | undefined {
  if (action.tool !== DISPATCH_SUBAGENT_TOOL_NAME) return undefined;
  const successfulDispatches = countSuccessfulSubagentDispatches(steps);
  if (successfulDispatches < ENOUGH_SUBAGENT_RESULTS_FOR_FINAL) return undefined;
  return `已完成 ${successfulDispatches} 次 dispatch_subagent 并取得足够子 Agent 结果；请直接汇总已有结果并输出 final，不要继续派生子 Agent。`;
}

/**
 * 写/命令型子任务只能继承父 Run 已取得的服务端授权。
 * permissionPolicy 只是可申请上限，不能授权子 Agent。
 */
export function assessSubagentSideEffectGuard(input: {
  action: SubagentToolAction;
  allowedPermissions: ToolPermission[];
  runGrantedPermissions?: readonly ToolPermission[];
}): string | undefined {
  if (input.action.tool !== DISPATCH_SUBAGENT_TOOL_NAME) return undefined;
  const tasks = Array.isArray(input.action.input?.tasks) ? (input.action.input.tasks as unknown[]) : [];
  const wantsWrite = tasks.some((task) => readPolicyFlag(task, "writeAllowed"));
  const wantsShell = tasks.some((task) => readPolicyFlag(task, "shellAllowed"));
  if (!wantsWrite && !wantsShell) return undefined;

  if (wantsWrite && !input.allowedPermissions.includes("write")) {
    return "子任务请求写权限，但当前运行未授予 write，已阻止派生。请改为只读子任务，或在授予写权限后重试。";
  }
  if (wantsShell && !input.allowedPermissions.includes("shell")) {
    return "子任务请求 shell 权限，但当前运行未授予 shell，已阻止派生。请改为只读子任务，或在授予 shell 权限后重试。";
  }

  if (wantsWrite && !input.runGrantedPermissions?.includes("write")) {
    return "派生写文件子 Agent 尚未取得父 Run 的 write grant；请先由 Agent 发起权限申请。";
  }
  if (wantsShell && !input.runGrantedPermissions?.includes("shell")) {
    return "派生执行命令子 Agent 尚未取得父 Run 的 shell grant；请先由 Agent 发起权限申请。";
  }
  return undefined;
}

export function renderDispatchSubagentFailure(step: AgentToolStep): string {
  const error = step.error ?? "未知错误";
  if (error.includes("invalid_input")) {
    return [
      `工具「${step.tool}」执行失败：${error}。`,
      "dispatch_subagent 参数须为 tasks: DelegatedTask[]，每项含 goal；写操作须 toolPolicy.writeAllowed 且 grantedPermissions 含 write。",
      "不要使用 roles/role/task 字符串，也不要使用 patch_worker/code_review/test_analyze 等固定角色；需要多个子 Agent 时请传多个 tasks。",
      "如果已经拿到足够子 Agent 结论，请直接输出 final。",
    ].join("\n");
  }
  if (error.includes("grantedPermissions 须包含 write")) {
    return [
      `工具「${step.tool}」执行失败：${error}。`,
      "写权限子任务须 toolPolicy.writeAllowed=true 且 grantedPermissions 含 write。若只是分析，请设置 writeAllowed=false。",
    ].join("\n");
  }
  return `工具「${step.tool}」执行失败：${error}。请修正 tasks 参数后再决定下一步；如果已有足够结果，请直接输出 final。`;
}

export function renderSubagentFinalConvergencePrompt(base: string, steps: AgentToolStep[]): string {
  const successfulDispatches = countSuccessfulSubagentDispatches(steps);
  if (successfulDispatches < ENOUGH_SUBAGENT_RESULTS_FOR_FINAL) return base;
  return [
    base,
    "",
    `已收集 ${successfulDispatches} 个子 Agent 结果，足以完成用户要求。下一步必须汇总这些结果并输出 final，不要继续调用 dispatch_subagent。`,
  ].join("\n");
}

function readPolicyFlag(task: unknown, key: "writeAllowed" | "shellAllowed"): boolean {
  if (!task || typeof task !== "object") return false;
  const policy = (task as { toolPolicy?: unknown }).toolPolicy;
  if (!policy || typeof policy !== "object") return false;
  return (policy as Record<string, unknown>)[key] === true;
}
