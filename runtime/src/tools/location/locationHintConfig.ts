import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { KEYWORD_PATH_HINTS as DEFAULT_KEYWORD_PATH_HINTS } from "./locationHeuristics.js";

export interface LocationKeywordHint {
  keywords: string[];
  path: string;
}

export type KeywordPathHintMatcher = (typeof DEFAULT_KEYWORD_PATH_HINTS)[number];

let cachedWorkspaceRoot: string | undefined;
let cachedHints: readonly KeywordPathHintMatcher[] | undefined;

function normalizeKeywords(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keywords = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return keywords.length > 0 ? keywords : undefined;
}

function loadHintsFromFile(workspaceRoot: string): LocationKeywordHint[] | undefined {
  const file = path.join(workspaceRoot, ".ariadne", "location-hints.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { hints?: unknown };
    if (!Array.isArray(parsed.hints)) return undefined;
    const hints: LocationKeywordHint[] = [];
    for (const item of parsed.hints) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const hintPath = typeof record.path === "string" ? record.path.trim() : "";
      const keywords = normalizeKeywords(record.keywords);
      if (!hintPath || !keywords) continue;
      hints.push({ path: hintPath, keywords });
    }
    return hints.length > 0 ? hints : undefined;
  } catch {
    return undefined;
  }
}

function toMatchers(hints: LocationKeywordHint[]): KeywordPathHintMatcher[] {
  return hints.map((hint) => ({
    path: hint.path,
    match: (normalized: string, raw: string) =>
      hint.keywords.some((keyword) => {
        const lower = keyword.toLowerCase();
        return normalized.includes(lower) || raw.includes(keyword);
      }),
  }));
}

/** 工作区关键词→路径提示；优先 `.ariadne/location-hints.json`，否则内置默认表。 */
export function resolveKeywordPathHints(workspaceRoot: string): readonly KeywordPathHintMatcher[] {
  if (cachedWorkspaceRoot === workspaceRoot && cachedHints) return cachedHints;
  const fromFile = loadHintsFromFile(workspaceRoot);
  cachedWorkspaceRoot = workspaceRoot;
  cachedHints = fromFile ? toMatchers(fromFile) : DEFAULT_KEYWORD_PATH_HINTS;
  return cachedHints;
}

/** 测试用：清除工作区提示缓存。 */
export function resetKeywordPathHintCache(): void {
  cachedWorkspaceRoot = undefined;
  cachedHints = undefined;
}
