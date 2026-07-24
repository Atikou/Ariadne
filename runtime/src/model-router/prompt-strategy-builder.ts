import type { RoutingContext } from "./context-analyzer.js";
import type { QualityMode, RouterDecision, TaskType } from "./types.js";

export type PromptResponseStyle = "concise" | "balanced" | "detailed";

/** V8：按路由决策与上下文信号生成调用参数与 system 补充（不调用模型）。 */
export interface PromptStrategy {
  temperature: number;
  responseStyle: PromptResponseStyle;
  preferJsonMode: boolean;
  systemAddendum: string;
  hints: string[];
}

export interface PromptStrategyInput {
  decision: RouterDecision;
  userInput: string;
  qualityMode?: QualityMode;
  routingContext?: RoutingContext;
}

const DETAILED_TASK_TYPES = new Set<TaskType>([
  "architecture",
  "document_qa",
  "code_edit",
  "high_risk_action",
]);

const JSON_TASK_TYPES = new Set<TaskType>(["architecture", "tool_action"]);

/**
 * 根据任务类型、风险、执行策略与 ContextAnalyzer 信号生成温度与 system 补充。
 */
export class PromptStrategyBuilder {
  build(input: PromptStrategyInput): PromptStrategy {
    const hints: string[] = [];
    const quality = input.qualityMode ?? "balanced";
    const taskType = input.decision.taskType;
    const strategy = input.decision.executionStrategy;
    const ctx = input.routingContext;

    let responseStyle: PromptResponseStyle = "balanced";
    let temperature = 0.3;

    if (quality === "fast" || taskType === "casual_chat" || taskType === "simple_qa") {
      responseStyle = "concise";
      temperature = 0.2;
      hints.push("style=concise");
    } else if (
      quality === "deep" ||
      DETAILED_TASK_TYPES.has(taskType) ||
      ctx?.complexity === "high"
    ) {
      responseStyle = "detailed";
      temperature = 0.25;
      hints.push("style=detailed");
    }

    if (strategy === "local_draft_remote_review") {
      temperature = 0.2;
      hints.push("pipeline=draft_review");
    } else if (strategy === "parallel_vote") {
      temperature = 0.35;
      hints.push("pipeline=parallel_vote");
    } else if (strategy === "strong_model_direct") {
      temperature = 0.2;
      hints.push("pipeline=strong_direct");
    }

    if (taskType === "debug" || taskType === "code_question") {
      temperature = Math.min(temperature, 0.25);
      hints.push("task=code_analysis");
    }

    const preferJsonMode =
      JSON_TASK_TYPES.has(taskType) ||
      strategy === "local_draft_remote_review" ||
      Boolean(input.decision.reviewModelId);

    const addendumParts: string[] = [];

    if (responseStyle === "detailed") {
      addendumParts.push("请给出结构化、可执行的回答；先结论后细节。");
    } else if (responseStyle === "concise") {
      addendumParts.push("请简洁作答，避免冗长铺垫。");
    }

    if (taskType === "high_risk_action" || input.decision.risk === "high") {
      addendumParts.push("涉及高风险操作：先说明风险、影响范围与需用户确认的步骤，不要默认执行。");
      hints.push("risk=high");
    }

    if (taskType === "architecture" || taskType === "document_qa") {
      addendumParts.push("若输出方案，请包含目标、范围、步骤、风险与验收标准。");
    }

    if (ctx?.hasToolIntent) {
      addendumParts.push("若需要工具，请明确工具名与输入，避免模糊描述。");
      hints.push("tool_intent");
    }

    if (ctx?.contextPressure === "high") {
      addendumParts.push("上下文较长：优先引用与问题最相关的片段，避免重复全文。");
      hints.push("long_context");
    }

    if (input.decision.contextSignals?.length) {
      hints.push(...input.decision.contextSignals.map((s) => `ctx:${s}`));
    }

    return {
      temperature,
      responseStyle,
      preferJsonMode,
      systemAddendum: addendumParts.join("\n"),
      hints,
    };
  }
}

export const defaultPromptStrategyBuilder = new PromptStrategyBuilder();

export function applyPromptStrategyToSystemText(
  systemBase: string,
  strategy: PromptStrategy,
): string {
  const trimmed = systemBase.trim();
  const addendum = strategy.systemAddendum.trim();
  if (!addendum) return trimmed;
  return trimmed ? `${trimmed}\n\n${addendum}` : addendum;
}
