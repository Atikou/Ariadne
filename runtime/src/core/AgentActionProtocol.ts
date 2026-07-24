import { z } from "zod";

export interface ToolAction {
  action: "tool";
  /** 厂商原生 tool call id；JSON 协议可省略。 */
  id?: string;
  tool: string;
  input?: Record<string, unknown>;
  thought?: string;
}

export interface ParallelToolCall {
  /** 厂商原生 tool call id；JSON 协议可省略。 */
  id?: string;
  tool: string;
  input?: Record<string, unknown>;
  thought?: string;
}

export interface ParallelToolAction {
  action: "tools";
  tools: ParallelToolCall[];
  thought?: string;
}

export interface FinalAction {
  action: "final";
  answer: string;
  /** 模型对本轮执行状态的结构化声明；最终真实性仍由 ToolLedger 裁决。 */
  completionClaim?: "completed" | "partial" | "blocked" | "historical";
}

export type AgentAction = ToolAction | ParallelToolAction | FinalAction;

/** 单轮可接收的工具调用数；实际并发度仍由子 Agent 队列控制。 */
export const MAX_PARALLEL_TOOL_CALLS = 8;

const ToolActionSchema = z
  .object({
    action: z.literal("tool"),
    id: z.string().min(1).optional(),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    thought: z.string().optional(),
  })
  .strict();

const ParallelToolCallSchema = z
  .object({
    id: z.string().min(1).optional(),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    thought: z.string().optional(),
  })
  .strict();

const ParallelToolActionSchema = z
  .object({
    action: z.literal("tools"),
    tools: z.array(ParallelToolCallSchema).min(2).max(MAX_PARALLEL_TOOL_CALLS),
    thought: z.string().optional(),
  })
  .strict();

const FinalActionSchema = z
  .object({
    action: z.literal("final"),
    answer: z.string(),
    completionClaim: z.enum(["completed", "partial", "blocked", "historical"]).optional(),
  })
  .strict();

const AgentActionSchema = z.discriminatedUnion("action", [
  ToolActionSchema,
  ParallelToolActionSchema,
  FinalActionSchema,
]);

export interface NativeToolCallLike {
  id?: string;
  name: string;
  arguments: unknown;
}

/** 去掉受支持的隐藏思考块；Markdown 围栏可能属于 final.answer，不能剥离。 */
export function stripModelNoise(content: string): string {
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<redacted_reasoning>[\s\S]*?(?:<\/redacted_reasoning>|$)/gi, "")
    .trim();
}

/**
 * 厂商隐藏推理只允许出现在响应包装层；显式 thought 字段也不得携带隐藏块。
 * 工具 input 与 final.answer 是业务载荷，必须保持原样。
 */
export function sanitizeAgentAction(action: AgentAction): AgentAction {
  if (action.action === "final") return { ...action };
  const sanitizeThought = (thought: string | undefined) => {
    if (thought == null) return undefined;
    const sanitized = stripModelNoise(thought);
    return sanitized || undefined;
  };
  if (action.action === "tool") {
    return { ...action, thought: sanitizeThought(action.thought) };
  }
  return {
    ...action,
    thought: sanitizeThought(action.thought),
    tools: action.tools.map((tool) => ({
      ...tool,
      thought: sanitizeThought(tool.thought),
    })),
  };
}

/** 严格解析整个响应；正文中嵌入 JSON 或字符串化 JSON 均不接受。 */
export function parseAgentAction(content: string): AgentAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripModelNoise(content));
  } catch {
    return null;
  }
  const result = AgentActionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * 统一消费 JSON ReAct 与厂商原生 tool_calls。原生调用存在时以结构化字段为准，
 * 避免 content 为空时被误判为协议错误。
 */
export function parseAgentModelAction(
  content: string,
  nativeToolCalls: readonly NativeToolCallLike[] | undefined,
): AgentAction | null {
  const calls = nativeToolCalls ?? [];
  if (calls.length === 0) return parseAgentAction(content);
  if (calls.length > MAX_PARALLEL_TOOL_CALLS) return null;

  const normalized: ParallelToolCall[] = [];
  for (const call of calls) {
    const input = normalizeNativeToolInput(call.arguments);
    if (!input) return null;
    normalized.push({
      id: call.id,
      tool: call.name,
      input,
    });
  }

  if (normalized.length === 1) {
    const call = normalized[0]!;
    return { action: "tool", id: call.id, tool: call.tool, input: call.input };
  }
  return {
    action: "tools",
    tools: normalized,
    thought: `并行处理 ${normalized.length} 个相互独立的工具调用`,
  };
}

function normalizeNativeToolInput(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
