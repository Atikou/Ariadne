import type { BackgroundTaskRecord } from "./types.js";
import type { BackgroundTriggerOnMatch, OutputMatchResult, OutputMatchRule } from "./outputTypes.js";
export {
  BackgroundTriggerOnMatchSchema,
  OUTPUT_MATCH_PRESETS,
  OutputMatchRuleSchema,
  type BackgroundTriggerOnMatch,
  type OutputMatchResult,
  type OutputMatchRule,
} from "./outputTypes.js";

function streamText(record: BackgroundTaskRecord, stream: OutputMatchRule["stream"]): string {
  if (stream === "stdout") return record.stdout;
  if (stream === "stderr") return record.stderr;
  return `${record.stdout}\n${record.stderr}`;
}

function testPattern(text: string, rule: OutputMatchRule): { matched: boolean; snippet?: string } {
  const flags = rule.ignoreCase ? "i" : "";
  let matched = false;
  if (rule.regex) {
    const re = new RegExp(rule.pattern, flags);
    const m = text.match(re);
    matched = m != null;
    return { matched, snippet: m?.[0]?.slice(0, 200) };
  }
  const hay = rule.ignoreCase ? text.toLowerCase() : text;
  const needle = rule.ignoreCase ? rule.pattern.toLowerCase() : rule.pattern;
  const idx = hay.indexOf(needle);
  matched = idx >= 0;
  return {
    matched,
    snippet: matched ? text.slice(idx, idx + Math.min(200, rule.pattern.length + 40)) : undefined,
  };
}

export function evaluateOutputRules(
  record: BackgroundTaskRecord,
  rules: OutputMatchRule[],
): OutputMatchResult[] {
  return rules.map((rule) => {
    const stream = rule.stream ?? "both";
    const { matched, snippet } = testPattern(streamText(record, stream), rule);
    return { name: rule.name, matched, stream, snippet };
  });
}

export function shouldTriggerOnMatch(
  record: BackgroundTaskRecord,
  rules: OutputMatchRule[],
  results: OutputMatchResult[],
  trigger: BackgroundTriggerOnMatch,
): boolean {
  if (rules.length === 0) return false;
  if (trigger.requireSuccess !== false && record.exitCode !== 0) return false;
  if (record.status !== "completed") return false;
  const mode = trigger.mode ?? "all";
  if (mode === "any") return results.some((r) => r.matched);
  return results.length > 0 && results.every((r) => r.matched);
}

export function matchRuleOnStream(
  record: BackgroundTaskRecord,
  rule: OutputMatchRule,
): OutputMatchResult | null {
  if (!rule.fireOnStream) return null;
  const stream = rule.stream ?? "both";
  const { matched, snippet } = testPattern(streamText(record, stream), rule);
  if (!matched) return null;
  return { name: rule.name, matched: true, stream, snippet, firedAt: new Date().toISOString() };
}
