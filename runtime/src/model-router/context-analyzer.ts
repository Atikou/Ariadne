import type { RouterInput } from "./types.js";
import { estimateTokensFromText } from "./router-context-estimate.js";

export type ContextComplexity = "low" | "medium" | "high";
export type ContextPressure = "low" | "medium" | "high";

/** V8：路由前对用户输入与上下文的结构化信号（不调用模型）。 */
export interface RoutingContext {
  complexity: ContextComplexity;
  contextPressure: ContextPressure;
  effectiveTokenEstimate: number;
  suggestedLevelBump: 0 | 1;
  suggestsCollaboration: boolean;
  hasCodeIntent: boolean;
  hasToolIntent: boolean;
  signals: string[];
}

const MEDIUM_CONTEXT_TOKENS = 24_000;
const HIGH_CONTEXT_TOKENS = 48_000;
const LONG_INPUT_CHARS = 1_200;

/**
 * 从 RouterInput 提取复杂度、上下文压力与协作/等级建议，供 DecisionEngine 多信号决策。
 */
export class ContextAnalyzer {
  analyze(input: RouterInput): RoutingContext {
    const signals: string[] = [];
    const text = input.userInput.trim();
    const tokenEst = Math.max(
      input.contextTokenEstimate ?? 0,
      estimateTokensFromText(text),
    );

    let contextPressure: ContextPressure = "low";
    if (tokenEst >= HIGH_CONTEXT_TOKENS) {
      contextPressure = "high";
      signals.push(`context_tokens>=${HIGH_CONTEXT_TOKENS}`);
    } else if (tokenEst >= MEDIUM_CONTEXT_TOKENS) {
      contextPressure = "medium";
      signals.push(`context_tokens>=${MEDIUM_CONTEXT_TOKENS}`);
    }

    const hasCodeIntent =
      /```|\.tsx?|\.jsx?|\.py\b|报错|bug|调试|函数|class |import |export /.test(text);
    const hasToolIntent =
      Boolean(input.mayUseTools) || /工具|shell|命令|执行|project_scan/.test(text);
    const hasArchitectureIntent = /架构|模块|重构|系统设计|完整方案/.test(text);

    let complexity: ContextComplexity = "low";
    if (
      hasArchitectureIntent ||
      text.length >= LONG_INPUT_CHARS ||
      contextPressure === "high" ||
      (input.recentMessagesCount ?? 0) >= 12
    ) {
      complexity = "high";
      signals.push("complexity=high");
    } else if (
      hasCodeIntent ||
      contextPressure === "medium" ||
      text.length >= 400 ||
      (input.recentMessagesCount ?? 0) >= 6
    ) {
      complexity = "medium";
      signals.push("complexity=medium");
    }

    let suggestedLevelBump: 0 | 1 = 0;
    if (contextPressure === "high" || (complexity === "high" && contextPressure !== "low")) {
      suggestedLevelBump = 1;
      signals.push("level_bump+1");
    }

    const suggestsCollaboration =
      !input.forceSingleModel &&
      input.allowCollaboration !== false &&
      input.qualityMode === "deep" &&
      (hasArchitectureIntent || complexity === "high") &&
      !input.localOnly;
    if (suggestsCollaboration) signals.push("suggest_collaboration");

    return {
      complexity,
      contextPressure,
      effectiveTokenEstimate: tokenEst,
      suggestedLevelBump,
      suggestsCollaboration,
      hasCodeIntent,
      hasToolIntent,
      signals,
    };
  }
}

export const defaultContextAnalyzer = new ContextAnalyzer();

/**
 * 将上下文信号合并进规则路由结果（不修改原对象）。
 */
export function applyRoutingContext<T extends {
  requiredLevel: 0 | 1 | 2 | 3;
  preferredStrategy?: import("./types.js").ExecutionStrategy;
  preferCollaboration?: boolean;
  taskType: import("./types.js").TaskType;
}>(rule: T, context: RoutingContext): T {
  const bumpedLevel = Math.min(
    3,
    rule.requiredLevel + context.suggestedLevelBump,
  ) as T["requiredLevel"];

  let preferredStrategy = rule.preferredStrategy;
  let preferCollaboration = rule.preferCollaboration ?? false;

  if (context.suggestsCollaboration && preferredStrategy !== "rule_only") {
    preferCollaboration = true;
    if (
      preferredStrategy === "single_model" &&
      (rule.taskType === "architecture" || rule.taskType === "document_qa")
    ) {
      preferredStrategy = "local_draft_remote_review";
    }
  }

  return {
    ...rule,
    requiredLevel: bumpedLevel,
    preferredStrategy,
    preferCollaboration,
  };
}
