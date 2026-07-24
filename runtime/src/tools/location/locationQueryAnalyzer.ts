import { DEFAULT_IGNORED_DIRS } from "../constants.js";
import {
  KEYWORD_PATH_HINTS,
  REVIEW_MODE_DEFAULT_PATH,
  STOP_WORDS,
} from "./locationHeuristics.js";
import { resolveKeywordPathHints } from "./locationHintConfig.js";
import type { SearchPlan } from "./locationTypes.js";
import { unique } from "./locationUtils.js";

export function analyzeTaskQuery(goal: string, mode?: string, workspaceRoot?: string): SearchPlan {
  const rawTokens = [...goal.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}|[\u4e00-\u9fa5]{2,}/g)].map(
    (m) => m[0],
  );
  const camelSymbols = rawTokens.filter(
    (t) => /[A-Z]/.test(t.slice(1)) || /^[A-Z][A-Za-z0-9_]+$/.test(t),
  );
  const keywords = unique(
    rawTokens
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .filter((t) => !STOP_WORDS.has(t.toLowerCase()))
      .slice(0, 16),
  );
  const lower = goal.toLowerCase();
  const possiblePaths = new Set<string>();
  const pathHints = workspaceRoot ? resolveKeywordPathHints(workspaceRoot) : KEYWORD_PATH_HINTS;
  for (const k of keywords) {
    const normalized = k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    for (const hint of pathHints) {
      if (hint.match(normalized, k)) possiblePaths.add(hint.path);
    }
  }
  if (possiblePaths.size === 0 && mode === "review") possiblePaths.add(REVIEW_MODE_DEFAULT_PATH);
  const taskType = lower.includes("debug") || goal.includes("排错")
    ? "debug"
    : lower.includes("review") || goal.includes("审阅")
      ? "review"
      : lower.includes("doc") || goal.includes("文档")
        ? "documentation"
        : keywords.length > 0
          ? "architecture_or_code_edit"
          : "unknown";
  return {
    goal,
    keywords,
    possibleSymbols: unique([...camelSymbols, ...keywords.filter((k) => /^[A-Z]/.test(k))]).slice(
      0,
      12,
    ),
    possiblePaths: [...possiblePaths].slice(0, 8),
    exclude: [...DEFAULT_IGNORED_DIRS],
    taskType,
  };
}
