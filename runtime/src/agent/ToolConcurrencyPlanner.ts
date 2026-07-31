import path from "node:path";

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolAction } from "./AgentActionParser.js";

export const DEFAULT_TOOL_CONCURRENCY = 4;

/**
 * 保持原始动作顺序，将可并发的纯读调用分成最大四个一组。写入、Shell、网络、
 * 未知工具或资源键相交的调用始终单独成组。
 */
export function planToolExecutionBatches(
  actions: readonly ToolAction[],
  registry: ToolRegistry,
  maxConcurrency = DEFAULT_TOOL_CONCURRENCY,
): number[][] {
  const limit = Math.max(1, Math.min(DEFAULT_TOOL_CONCURRENCY, Math.floor(maxConcurrency)));
  const batches: number[][] = [];
  let parallelBatch: number[] = [];
  let parallelKeys = new Set<string>();

  const flush = () => {
    if (parallelBatch.length > 0) batches.push(parallelBatch);
    parallelBatch = [];
    parallelKeys = new Set<string>();
  };

  actions.forEach((action, index) => {
    const contract = registry.get(action.tool);
    if (!isParallelObservationTool(contract)) {
      flush();
      batches.push([index]);
      return;
    }
    const keys = extractResourceKeys(action);
    if (
      parallelBatch.length >= limit ||
      [...keys].some((key) => [...parallelKeys].some((existing) => resourcesConflict(key, existing)))
    ) {
      flush();
    }
    parallelBatch.push(index);
    for (const key of keys) parallelKeys.add(key);
  });
  flush();
  return batches;
}

export function isParallelObservationTool(
  contract: ReturnType<ToolRegistry["get"]>,
): boolean {
  return Boolean(
    contract &&
      contract.parallelism === "parallel_safe" &&
      contract.permissions.every((permission) => permission === "read") &&
      contract.effects.every((effect) => effect === "none" || effect === "workspace_read"),
  );
}

/**
 * Provider tool-call batches must be completed without a permission pause in
 * the middle. Cross-workspace reads therefore stay serial even though reads
 * inside the active workspace may run in parallel.
 */
export function isImmediatelyParallelObservationAction(
  action: ToolAction,
  registry: ToolRegistry,
  workspaceRoot: string,
): boolean {
  if (!isParallelObservationTool(registry.get(action.tool))) return false;
  return collectPathLikeValues(action.input ?? {}).every(
    (target) => isInsideWorkspace(workspaceRoot, target),
  );
}

function extractResourceKeys(action: ToolAction): Set<string> {
  const input = action.input ?? {};
  const values: string[] = [];
  for (const key of ["path", "root", "dir", "cwd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) values.push(value);
  }
  for (const key of ["paths", "files"]) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) values.push(item);
      }
    }
  }
  if (values.length === 0) return new Set([`tool:${action.tool}`]);
  return new Set(values.map(normalizeResourceKey));
}

function normalizeResourceKey(value: string): string {
  const normalized = path.posix
    .normalize(value.trim().replace(/\\/g, "/"))
    .replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized.toLowerCase();
}

function resourcesConflict(left: string, right: string): boolean {
  if (left.startsWith("tool:") || right.startsWith("tool:")) return left === right;
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const PATH_FIELDS = new Set(["path", "file", "root", "dir", "cwd"]);
const PATH_ARRAY_FIELDS = new Set(["paths", "files"]);

function collectPathLikeValues(
  value: unknown,
  parentKey?: string,
  output: string[] = [],
): string[] {
  if (typeof value === "string") {
    if (parentKey && PATH_FIELDS.has(parentKey) && value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    if (parentKey && PATH_ARRAY_FIELDS.has(parentKey)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) output.push(item.trim());
      }
      return output;
    }
    for (const item of value) collectPathLikeValues(item, undefined, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectPathLikeValues(child, key.toLowerCase(), output);
  }
  return output;
}

function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
