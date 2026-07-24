import { PlanSchema, type Plan, type PlanStep } from "./types.js";

/** 按 id 索引步骤；重复 id 抛错。 */
export function indexPlanSteps(steps: PlanStep[]): Map<string, PlanStep> {
  const byId = new Map<string, PlanStep>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`重复步骤 id：${step.id}`);
    byId.set(step.id, step);
  }
  return byId;
}

/** 校验 dependsOn 引用与无环。 */
export function validateTaskGraph(steps: PlanStep[]): void {
  const byId = indexPlanSteps(steps);
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.id) throw new Error(`步骤 ${step.id} 不能依赖自身`);
      if (!byId.has(dep)) throw new Error(`步骤 ${step.id} 依赖未知步骤：${dep}`);
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();

  const dfs = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`任务依赖图存在环（涉及 ${id}）`);
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) dfs(dep);
    visiting.delete(id);
    done.add(id);
  };

  for (const step of steps) dfs(step.id);
}

const TERMINAL_FAILURE = new Set<PlanStep["status"]>(["failed", "blocked", "cancelled"]);

/** 依赖未满足时返回阻塞原因；全部 completed 则返回 undefined。 */
export function dependencyBlockReason(
  step: PlanStep,
  byId: Map<string, PlanStep>,
): string | undefined {
  for (const depId of step.dependsOn ?? []) {
    const dep = byId.get(depId)!;
    if (dep.status === "completed" || dep.status === "skipped") continue;
    if (dep.status === "failed") return `依赖步骤 ${depId} 已失败`;
    if (dep.status === "blocked") return `依赖步骤 ${depId} 已阻塞`;
    if (dep.status === "cancelled") return `依赖步骤 ${depId} 已取消`;
    // pending / running：尚未就绪，由 readyPendingSteps 跳过
    return undefined;
  }
  return undefined;
}

/** 依赖已全部 completed。 */
export function dependenciesSatisfied(step: PlanStep, byId: Map<string, PlanStep>): boolean {
  return (step.dependsOn ?? []).every((depId) => {
    const status = byId.get(depId)!.status;
    return status === "completed" || status === "skipped";
  });
}

/** 将因上游失败/阻塞/取消而无法执行的 pending 步骤标记终止态。 */
export function propagateDependencyBlocks(steps: PlanStep[], byId: Map<string, PlanStep>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      const reason = dependencyBlockReason(step, byId);
      if (!reason) continue;
      const blockedByTerminal = (step.dependsOn ?? []).some((depId) =>
        TERMINAL_FAILURE.has(byId.get(depId)!.status),
      );
      if (!blockedByTerminal) continue;
      if ((step.dependsOn ?? []).some((depId) => byId.get(depId)!.status === "cancelled")) {
        step.status = "cancelled";
        step.error = reason;
      } else {
        step.status = "blocked";
        step.error = reason;
      }
      changed = true;
    }
  }
}

/** 当前可并行启动的 pending 步骤（依赖已 completed）。 */
export function readyPendingSteps(steps: PlanStep[], byId: Map<string, PlanStep>): PlanStep[] {
  return steps.filter(
    (step) => step.status === "pending" && dependenciesSatisfied(step, byId),
  );
}

/**
 * 按依赖拓扑 + priority（小者优先）重排子任务，用于计划展示与持久化 position。
 * 不改变步骤内容，仅调整数组顺序。
 */
export function sortSubtasksByPriority(steps: PlanStep[]): PlanStep[] {
  if (steps.length <= 1) return [...steps];
  validateTaskGraph(steps);
  const byId = indexPlanSteps(steps);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      dependents.get(dep)!.push(step.id);
    }
  }

  const ready = steps
    .filter((s) => (inDegree.get(s.id) ?? 0) === 0)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const ordered: PlanStep[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const nextId of dependents.get(current.id) ?? []) {
      const deg = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) {
        const next = byId.get(nextId)!;
        ready.push(next);
        ready.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      }
    }
  }

  if (ordered.length !== steps.length) {
    throw new Error("任务依赖图存在环，无法排序子任务");
  }
  return ordered;
}

/** API 提交的计划：校验依赖图并按 priority 重排子任务。 */
export function finalizePlan(plan: Plan): Plan {
  return PlanSchema.parse({
    ...plan,
    steps: sortSubtasksByPriority(plan.steps),
  });
}
