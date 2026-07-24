import type { FallbackTrigger, RouterDecision } from "./types.js";

export type AnswerEvaluationVerdict = "pass" | "needs_fallback";

export interface AnswerEvaluation {
  source: "rule_stub";
  verdict: AnswerEvaluationVerdict;
  score: number;
  trigger?: FallbackTrigger;
  reasons: string[];
}

export interface AnswerEvaluatorInput {
  decision: RouterDecision;
  answer: string;
  userInput: string;
  minComplexAnswerChars?: number;
}

const DEFAULT_MIN_COMPLEX_ANSWER_CHARS = 80;

/**
 * V4 规则版答案足够性评估，由 ModelOrchestrator 与 FallbackManager 运行时调用。
 */
export class AnswerEvaluator {
  evaluate(input: AnswerEvaluatorInput): AnswerEvaluation {
    const answer = input.answer.trim();
    if (!answer) {
      return {
        source: "rule_stub",
        verdict: "needs_fallback",
        score: 0,
        trigger: "empty_output",
        reasons: ["answer_empty"],
      };
    }

    const minChars = input.minComplexAnswerChars ?? DEFAULT_MIN_COMPLEX_ANSWER_CHARS;
    const complex =
      input.decision.selectedLevel >= 2 ||
      input.decision.taskType === "architecture" ||
      input.decision.taskType === "document_qa" ||
      input.userInput.length > 120;

    if (complex && answer.length < minChars) {
      return {
        source: "rule_stub",
        verdict: "needs_fallback",
        score: Math.max(0.1, answer.length / minChars),
        trigger: "answer_too_short",
        reasons: ["complex_answer_too_short"],
      };
    }

    return {
      source: "rule_stub",
      verdict: "pass",
      score: 1,
      reasons: [],
    };
  }
}
