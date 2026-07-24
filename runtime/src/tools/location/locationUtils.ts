import type { SearchPlan } from "./locationTypes.js";

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isSearchPlanTaskType(value: unknown): value is SearchPlan["taskType"] {
  return (
    value === "architecture_or_code_edit" ||
    value === "debug" ||
    value === "review" ||
    value === "documentation" ||
    value === "unknown"
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
