import type { AgentToolStep } from "../agent/toolStep.js";

/** 可序列化的定位搜索计划（与 `SearchPlan` 字段对齐）。 */
export interface RunStateSearchPlan {
  goal: string;
  keywords: string[];
  possibleSymbols: string[];
  possiblePaths: string[];
  exclude: string[];
  taskType: string;
}

/** RunState 中保存的定位进度，供续跑与 ProjectIndex 联动。 */
export interface RunStateLocationContext {
  projectId: string;
  searchPlan?: RunStateSearchPlan;
  visitedFiles: string[];
  visitedDirs: string[];
  candidateFiles: string[];
  primaryFiles: string[];
  indexFileCount?: number;
  indexSymbolCount?: number;
}

function readPathItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
        return (item as { path: string }).path;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeSearchPlan(value: unknown): RunStateSearchPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const plan = value as Record<string, unknown>;
  if (typeof plan.goal !== "string") return undefined;
  return {
    goal: plan.goal,
    keywords: readStringArray(plan.keywords),
    possibleSymbols: readStringArray(plan.possibleSymbols),
    possiblePaths: readStringArray(plan.possiblePaths),
    exclude: readStringArray(plan.exclude),
    taskType: typeof plan.taskType === "string" ? plan.taskType : "unknown",
  };
}

/** 从 locate_relevant_files 步骤提取可续跑定位上下文。 */
export function extractLocationContextFromSteps(
  steps: AgentToolStep[],
  options?: { projectIndexFileCount?: number; projectIndexSymbolCount?: number },
): RunStateLocationContext | undefined {
  const locateSteps = steps.filter((s) => s.tool === "locate_relevant_files");
  if (!locateSteps.length && options?.projectIndexFileCount == null) return undefined;

  const visitedFiles = new Set<string>();
  const visitedDirs = new Set<string>();
  const candidateFiles = new Set<string>();
  const primaryFiles = new Set<string>();
  let searchPlan: RunStateSearchPlan | undefined;
  let projectId = "default";

  for (const step of locateSteps) {
    const output = step.output as Record<string, unknown> | undefined;
    if (!output) continue;
    if (typeof output.projectId === "string") projectId = output.projectId;
    const stats = output.locateStats as Record<string, unknown> | undefined;
    for (const file of readPathItems(stats?.visitedFiles)) visitedFiles.add(file);
    for (const dir of readStringArray(stats?.visitedDirs)) visitedDirs.add(dir);
    for (const file of readPathItems(output.candidateFiles)) candidateFiles.add(file);
    for (const file of readPathItems(output.primaryFiles)) primaryFiles.add(file);
    const plan = normalizeSearchPlan(output.searchPlan);
    if (plan) searchPlan = plan;
  }

  for (const step of steps) {
    if (!step.ok || step.tool !== "read_file") continue;
    const filePath = (step.input as { path?: unknown }).path;
    if (typeof filePath === "string") visitedFiles.add(filePath);
  }

  return {
    projectId,
    searchPlan,
    visitedFiles: [...visitedFiles].slice(0, 80),
    visitedDirs: [...visitedDirs].slice(0, 40),
    candidateFiles: [...candidateFiles].slice(0, 40),
    primaryFiles: [...primaryFiles].slice(0, 20),
    indexFileCount: options?.projectIndexFileCount,
    indexSymbolCount: options?.projectIndexSymbolCount,
  };
}
