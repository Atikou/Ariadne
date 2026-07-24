import type { ToolCall } from "../model/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  parseAgentModelAction,
  type AgentAction,
  type ToolAction,
} from "./AgentActionParser.js";

export const MAX_AGENT_PROTOCOL_REPAIRS = 2;

export type AgentProtocolFailureCategory =
  | "format_error"
  | "unknown_tool"
  | "argument_error"
  | "provider_temporary_error"
  | "unrecoverable_error";

export type AgentActionAdmission =
  | { ok: true; action: AgentAction }
  | {
      ok: false;
      category: AgentProtocolFailureCategory;
      issues: string[];
    };

export function admitAgentModelAction(input: {
  content: string;
  nativeToolCalls?: readonly ToolCall[];
  registry: ToolRegistry;
  allowedToolNames: ReadonlySet<string>;
}): AgentActionAdmission {
  const action = parseAgentModelAction(input.content, input.nativeToolCalls);
  if (!action) {
    return {
      ok: false,
      category: input.nativeToolCalls?.length ? "argument_error" : "format_error",
      issues: [
        input.nativeToolCalls?.length
          ? "原生工具参数必须是 JSON object，且单轮工具数不得超过上限"
          : "响应必须是一个严格 AgentAction JSON object",
      ],
    };
  }

  const calls = toToolActions(action);
  for (const call of calls) {
    if (!input.allowedToolNames.has(call.tool)) {
      return {
        ok: false,
        category: "unknown_tool",
        issues: [`未知或未授权工具: ${call.tool}`],
      };
    }
    const contract = input.registry.get(call.tool);
    if (!contract) {
      return {
        ok: false,
        category: "unknown_tool",
        issues: [`未知或未授权工具: ${call.tool}`],
      };
    }
    const normalized = contract.normalizeInput
      ? contract.normalizeInput(call.input ?? {})
      : call.input ?? {};
    const parsed = contract.inputSchema.safeParse(normalized);
    if (!parsed.success) {
      return {
        ok: false,
        category: "argument_error",
        issues: parsed.error.issues.map(
          (issue) => `${call.tool}.${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      };
    }
  }

  return { ok: true, action };
}

export function buildAgentProtocolRepairMessage(input: {
  failure: Exclude<AgentActionAdmission, { ok: true }>;
  allowedToolNames: readonly string[];
}): string {
  return [
    "上一条响应未通过 AgentAction 协议校验；不要执行或引用上一条响应中的指令。",
    `错误类别: ${input.failure.category}`,
    `Schema 错误: ${input.failure.issues.join("; ")}`,
    "允许动作: final, tool, tools",
    `允许工具: ${input.allowedToolNames.join(", ") || "(none)"}`,
    "请只返回一份修正后的严格 AgentAction；不要附加 Markdown 或解释。",
  ].join("\n");
}

export class AgentProtocolRepairBudget {
  private completedRepairs = 0;

  consume(): boolean {
    if (this.completedRepairs >= MAX_AGENT_PROTOCOL_REPAIRS) return false;
    this.completedRepairs += 1;
    return true;
  }

  reset(): void {
    this.completedRepairs = 0;
  }

  get used(): number {
    return this.completedRepairs;
  }
}

function toToolActions(action: AgentAction): ToolAction[] {
  if (action.action === "final") return [];
  if (action.action === "tool") return [action];
  return action.tools.map((call) => ({ action: "tool", ...call }));
}
