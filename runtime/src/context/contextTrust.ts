import type { ContentEnvelope, MessageEnvelope, MessageKind } from "./messageEnvelope.js";
import { createContentEnvelope, isVerifiedContent, resolveMessageEnvelope } from "./messageEnvelope.js";
import type { RunExecutionFacts, RunFactsLookup } from "./runFactsLookup.js";
import { runFactsIndicateMisleadingCompletion } from "./runFactsLookup.js";
import type { MessageRecord } from "./types.js";
import type { ToolCall } from "../model/types.js";

export type ContextTrustDecisionReason =
  | "user_input"
  | "verified_final"
  | "verified_tool_result"
  | "guard_notice"
  | "filtered_raw_model_final"
  | "filtered_tool_action"
  | "filtered_unverified_assistant"
  | "filtered_workflow_event"
  | "filtered_misleading_completion";

export interface ContextTrustDecision {
  include: boolean;
  reason: ContextTrustDecisionReason;
  envelope: MessageEnvelope;
  /** 若因虚假完成被排除，可生成纠偏摘要。 */
  needsCorrection?: boolean;
  correctionText?: string;
}

const COMPLETION_CLAIM_RE =
  /已成功|已安装|安装完成|已修改|修改完成|已写入|写入完成|已执行|执行完成|已完成|增强方案.*完成|npm install.*成功/i;

export interface ContextMessageLike {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  messageKind?: MessageKind;
  uiVisible?: boolean;
  contentEnvelope?: ContentEnvelope;
  runId?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
  toolCalls?: ToolCall[];
}

export function shouldIncludeInContext(
  message: ContextMessageLike,
  runLookup?: RunFactsLookup,
): ContextTrustDecision {
  return evaluateContextMessageTrust(message, runLookup);
}

export function evaluateContextMessageTrust(
  message: ContextMessageLike,
  runLookup?: RunFactsLookup,
): ContextTrustDecision {
  let envelope = resolveMessageEnvelope({
    role: message.role,
    content: message.content,
    messageKind: message.messageKind,
    uiVisible: message.uiVisible,
    contentEnvelope: message.contentEnvelope,
    runId: message.runId,
    ledgerBacked: message.ledgerBacked,
    outcomeClass: message.outcomeClass,
    outcomeKind: message.outcomeKind,
  });

  if (
    message.role === "user" &&
    envelope.messageKind === "user_input" &&
    envelope.contentEnvelope.origin === "user" &&
    envelope.contentEnvelope.integrityEvidence.kind === "user_authored" &&
    isVerifiedContent(envelope.contentEnvelope)
  ) {
    return { include: true, reason: "user_input", envelope };
  }

  if (envelope.messageKind === "tool_action") {
    return {
      include: false,
      reason: "filtered_tool_action",
      envelope,
    };
  }

  if (envelope.messageKind === "raw_model_final") {
    const facts = runLookup?.get(message.runId);
    return {
      include: false,
      reason: "filtered_raw_model_final",
      envelope,
      needsCorrection: true,
      correctionText: buildMisleadingCorrection(message, facts, envelope),
    };
  }

  if (envelope.messageKind === "guard_notice" && isVerifiedContent(envelope.contentEnvelope)) {
    return { include: true, reason: "guard_notice", envelope };
  }

  if (envelope.messageKind === "conversational_reply") {
    return isVerifiedContent(envelope.contentEnvelope)
      ? { include: true, reason: "verified_final", envelope }
      : { include: false, reason: "filtered_unverified_assistant", envelope };
  }

  if (envelope.messageKind === "tool_result") {
    const ledgerBacked =
      message.ledgerBacked ??
      (message.outcomeClass === "observation_success" &&
        message.outcomeKind !== "not_found" &&
        message.outcomeKind !== "no_results");
    const claimsCompletion = isUnverifiedCompletionMemoryText(message.content);
    if (claimsCompletion && !ledgerBacked) {
      return {
        include: false,
        reason: "filtered_misleading_completion",
        envelope,
        needsCorrection: true,
        correctionText: [
          "【上下文事实纠偏 · 工具结果不可作完成依据】",
          "历史 tool 消息含未验证的完成声明，且缺少 ledger 成功副作用证明。",
          "请以当前 Run 的 Tool Ledger 与工具执行结果为准。",
        ].join("\n"),
      };
    }
    if (!isVerifiedContent(envelope.contentEnvelope)) {
      return {
        include: false,
        reason: "filtered_unverified_assistant",
        envelope,
      };
    }
    return {
      include: true,
      reason: "verified_tool_result",
      envelope,
    };
  }

  if (envelope.messageKind === "workflow_event") {
    return {
      include: false,
      reason: "filtered_workflow_event",
      envelope,
    };
  }

  if (envelope.messageKind === "final_answer") {
    if (isVerifiedContent(envelope.contentEnvelope)) {
      return { include: true, reason: "verified_final", envelope };
    }

    const facts = runLookup?.get(message.runId);

    if (facts && runFactsIndicateMisleadingCompletion(facts)) {
      return {
        include: false,
        reason: "filtered_misleading_completion",
        envelope,
        needsCorrection: true,
        correctionText: buildMisleadingCorrection(message, facts, envelope),
      };
    }

    if (claimsCompletionInText(message.content) && !facts) {
      return {
        include: false,
        reason: "filtered_unverified_assistant",
        envelope,
        needsCorrection: true,
        correctionText: buildUnverifiedLegacyCorrection(message),
      };
    }

    if (claimsCompletionInText(message.content)) {
      return {
        include: false,
        reason: "filtered_unverified_assistant",
        envelope,
        needsCorrection: true,
        correctionText: facts
          ? buildMisleadingCorrection(message, facts, envelope)
          : buildUnverifiedLegacyCorrection(message),
      };
    }

    return {
      include: false,
      reason: "filtered_unverified_assistant",
      envelope,
    };
  }

  return {
    include: false,
    reason: "filtered_workflow_event",
    envelope,
  };
}

export function buildContextCorrections(
  decisions: Array<{ message: ContextMessageLike; decision: ContextTrustDecision }>,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { decision } of decisions) {
    if (!decision.needsCorrection || !decision.correctionText) continue;
    if (seen.has(decision.correctionText)) continue;
    seen.add(decision.correctionText);
    lines.push(decision.correctionText);
  }
  return lines;
}

export function claimsCompletionInText(text: string): boolean {
  return COMPLETION_CLAIM_RE.test(text);
}

export function isUnverifiedCompletionMemoryText(text: string): boolean {
  return claimsCompletionInText(text);
}

/** 从结构化摘要中剔除未验证的「已完成」声明行。 */
export function scrubStructuredSummaryContent<T extends {
  current_goal?: string;
  important_decisions?: string[];
  project_state?: string[];
  open_questions?: string[];
  recent_changes?: string[];
}>(content: T): T {
  const scrubLine = (line: string) => !isUnverifiedCompletionMemoryText(line);
  const goal =
    content.current_goal && isUnverifiedCompletionMemoryText(content.current_goal)
      ? undefined
      : content.current_goal;
  return {
    ...content,
    current_goal: goal,
    important_decisions: (content.important_decisions ?? []).filter(scrubLine),
    project_state: (content.project_state ?? []).filter(scrubLine),
    open_questions: (content.open_questions ?? []).filter(scrubLine),
    recent_changes: (content.recent_changes ?? []).filter(scrubLine),
  };
}

function buildMisleadingCorrection(
  message: ContextMessageLike,
  facts: RunExecutionFacts | null | undefined,
  envelope: MessageEnvelope,
): string {
  const runRef = facts?.runId ?? message.runId ?? "未知";
  const goal = facts?.goal ? `「${facts.goal}」` : "该任务";
  const shell = facts?.toolLedger?.successfulShellCalls ?? 0;
  const write = facts?.toolLedger?.successfulWriteCalls ?? 0;
  const preview = extractAnswerPreview(message.content);
  return [
    "【上下文事实纠偏 · 历史结论已失效】",
    `历史 Run ${runRef.slice(0, 8)}… 中，模型曾声称${goal}已完成${preview ? `（如：${preview}）` : ""}。`,
    `Tool Ledger 事实：shell 成功 ${shell} 次 / 写成功 ${write} 次。`,
    `completionStatus=${facts?.completionStatus ?? envelope.messageKind}。`,
    "该历史结论不可作为当前事实；副作用任务必须以工具执行结果为准。",
  ].join("\n");
}

function buildUnverifiedLegacyCorrection(message: ContextMessageLike): string {
  const preview = extractAnswerPreview(message.content);
  return [
    "【上下文事实纠偏 · 未验证的历史完成声明】",
    preview
      ? `会话历史中存在未验证的完成声明：「${preview}」。`
      : "会话历史中存在未验证的 assistant 完成声明。",
    "无法关联 Run 事实或 Tool Ledger，该声明不得作为副作用已完成的依据。",
  ].join("\n");
}

function extractAnswerPreview(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { action?: string; answer?: string };
      if (parsed.action === "final" && typeof parsed.answer === "string") {
        return parsed.answer.slice(0, 120);
      }
    } catch {
      /* ignore */
    }
  }
  return trimmed.slice(0, 120);
}

export function filterVerifiedMemories<T extends { memory: { value: string; summary?: string; source?: string; memoryType: string } }>(
  items: T[],
): T[] {
  return items.filter((item) => {
    const m = item.memory;
    if (m.source === "tool_ledger") return true;
    const text = `${m.value}\n${m.summary ?? ""}`;
    if (!isUnverifiedCompletionMemoryText(text)) return true;
    return false;
  });
}

export function toContextCorrectionMessage(text: string, index: number): ContextMessageLike {
  const ts = new Date().toISOString();
  return {
    id: `context-correction-${index}`,
    role: "system",
    content: text,
    createdAt: ts,
    messageKind: "guard_notice",
    uiVisible: false,
    contentEnvelope: createContentEnvelope({
      origin: "guard",
      evidence: "completion_guard",
      verified: true,
      instructionAuthority: "system",
      externalContent: false,
      egressAllowed: ["model"],
    }),
  };
}
