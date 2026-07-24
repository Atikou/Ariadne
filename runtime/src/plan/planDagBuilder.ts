import type { UserVisibleTodo } from "./types.js";

const PRIORITY_ORDER: Record<UserVisibleTodo["priority"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * 为 Todo 编译 DAG：同优先级 band 内并行（无互相依赖），仅依赖更低优先级 band 的全部步骤。
 */
export function buildTodoDependsOn(selected: UserVisibleTodo[], todo: UserVisibleTodo): string[] {
  const myBand = PRIORITY_ORDER[todo.priority];
  const prevBandIds = selected
    .filter((item) => PRIORITY_ORDER[item.priority] < myBand)
    .map((item) => item.id);
  return prevBandIds;
}

/** 将步骤按 DAG 波次分组（拓扑层级），用于执行可观测性。 */
export function groupStepsIntoDagWaves<T extends { id: string; dependsOn?: string[] }>(
  steps: T[],
): T[][] {
  if (steps.length === 0) return [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const remaining = new Set(steps.map((s) => s.id));
  const waves: T[][] = [];

  while (remaining.size > 0) {
    const wave = steps.filter(
      (step) =>
        remaining.has(step.id) &&
        (step.dependsOn ?? []).every((depId) => !remaining.has(depId)),
    );
    if (wave.length === 0) {
      throw new Error("DAG 波次划分失败：可能存在环或未解析依赖");
    }
    for (const step of wave) remaining.delete(step.id);
    waves.push(wave);
  }

  // 保持与输入 steps 顺序无关的稳定性
  void byId;
  return waves;
}
