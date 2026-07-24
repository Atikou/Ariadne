import type { ModelClient } from "./types.js";

/** 任务类型提示：影响候选排序，不替代 routing.strategy 与 sensitive 约束。 */
export const MODEL_TASK_TYPES = ["simple", "reasoning", "codegen", "long_context"] as const;
export type ModelTaskType = (typeof MODEL_TASK_TYPES)[number];

export function isModelTaskType(value: unknown): value is ModelTaskType {
  return typeof value === "string" && (MODEL_TASK_TYPES as readonly string[]).includes(value);
}

export function parseModelTaskTypeOrError(
  value: unknown,
): { ok: true; taskType?: ModelTaskType } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (isModelTaskType(value)) return { ok: true, taskType: value };
  return { ok: false, error: `taskType 无效，可选：${MODEL_TASK_TYPES.join(", ")}` };
}

/**
 * 按任务类型重排候选（simple → 本地优先；其余 → 远程优先）。
 * 返回 null 表示未指定 taskType，由调用方按 strategy 排序。
 */
export function orderCandidatesByTaskType(
  taskType: ModelTaskType | undefined,
  local: ModelClient[],
  remote: ModelClient[],
): ModelClient[] | null {
  if (!taskType) return null;
  if (taskType === "simple") return [...local, ...remote];
  return [...remote, ...local];
}
