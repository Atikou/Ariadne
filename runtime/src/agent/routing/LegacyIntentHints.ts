import type { AgentIntentType } from "../IntentTypes.js";
import {
  matchFallbackIntent,
  matchUnicodeIntent,
  normalizeIntentText,
} from "../intentPatterns.js";
import { isAgentStepFailureFeedback } from "../agentFailureFeedback.js";

/** Legacy 关键词仅作 hint，不直接决定最终 intent/mode/workflow。 */
export interface LegacyIntentHints {
  hintedIntent?: AgentIntentType;
  hintSources: string[];
}

export function extractLegacyIntentHints(message: string): LegacyIntentHints {
  const raw = message.trim();
  const text = normalizeIntentText(raw);
  const hintSources: string[] = [];
  let hintedIntent: AgentIntentType | undefined;

  if (isAgentStepFailureFeedback(raw)) {
    hintedIntent = "debug";
    hintSources.push("failure_payload:debug");
    return { hintedIntent, hintSources };
  }

  const unicode = matchUnicodeIntent(text);
  if (unicode) {
    hintedIntent = unicode;
    hintSources.push(`unicode:${unicode}`);
  }
  const keyword = matchFallbackIntent(text);
  if (keyword) {
    if (!hintedIntent) hintedIntent = keyword;
    hintSources.push(`keyword:${keyword}`);
  }

  return { hintedIntent, hintSources };
}
