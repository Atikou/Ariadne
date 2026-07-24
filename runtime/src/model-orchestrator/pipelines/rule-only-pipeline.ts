import { resolveRuleOnlyAnswer } from "../../model-router/rule-only-responses.js";
import type { OrchestratorInput, OrchestratorResult } from "../types.js";

/** Level 0：规则直答，不写入 model_call_logs。 */
export function runRuleOnlyPipeline(input: OrchestratorInput): OrchestratorResult {
  const answer = resolveRuleOnlyAnswer(input.routerDecision.taskType, input.userInput);
  return {
    finalAnswer: answer,
    usedStrategy: "rule_only",
    usedModelIds: [],
    modelCallIds: [],
    clientName: "rule-only",
    modelName: "rule-only",
    location: "local",
    latencyMs: 0,
  };
}
