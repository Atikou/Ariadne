import type { ChatRole } from "../model/types.js";

export type MessageKind =
  | "user_input"
  | "tool_action"
  | "conversational_reply"
  | "final_answer"
  | "raw_model_final"
  | "tool_result"
  | "workflow_event"
  | "guard_notice";

export type MessageSource = "user" | "model" | "guard" | "tool" | "workflow" | "system";
export type MessageTrustBasis =
  | "user_authored"
  | "conversational_reply"
  | "completion_guard"
  | "tool_ledger";

export interface MessageEnvelope {
  messageKind: MessageKind;
  uiVisible: boolean;
  trusted: boolean;
  source: MessageSource;
  trustBasis?: MessageTrustBasis;
  runId?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export interface MessageEnvelopeInput {
  role?: ChatRole | string;
  messageKind?: MessageKind;
  uiVisible?: boolean;
  /** 仅可用于进一步降级；设置 true 不能替代 trustBasis。 */
  trusted?: boolean;
  source?: MessageSource;
  trustBasis?: MessageTrustBasis;
  runId?: string;
  content?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export function resolveMessageEnvelope(input: MessageEnvelopeInput): MessageEnvelope {
  if (!input.messageKind) return inferEnvelopeFromLegacy(input.role ?? "system", input.content);

  const source = input.source ?? defaultSource(input.messageKind);
  const trustBasis = resolveTrustBasis(input, source);
  const trusted =
    input.trusted !== false &&
    hasValidTrustProof({
      role: input.role,
      kind: input.messageKind,
      source,
      trustBasis,
      runId: input.runId,
      ledgerBacked: input.ledgerBacked,
    });
  const uiEligible =
    input.messageKind === "user_input" ||
    input.messageKind === "conversational_reply" ||
    input.messageKind === "final_answer";

  return {
    messageKind: input.messageKind,
    uiVisible: trusted && uiEligible && (input.uiVisible ?? defaultUiVisible(input.messageKind)),
    trusted,
    source,
    trustBasis: trusted ? trustBasis : undefined,
    runId: input.runId,
    ledgerBacked: input.ledgerBacked,
    outcomeClass: input.outcomeClass,
    outcomeKind: input.outcomeKind,
  };
}

export function defaultUiVisible(kind: MessageKind): boolean {
  return kind === "user_input" || kind === "conversational_reply" || kind === "final_answer";
}

/** 没有 trustBasis 时一律 fail-closed；user_input 仅在 role=user 时自动签发。 */
export function defaultTrusted(_kind: MessageKind): boolean {
  return false;
}

export function defaultSource(kind: MessageKind): MessageSource {
  switch (kind) {
    case "user_input":
      return "user";
    case "tool_action":
    case "raw_model_final":
    case "conversational_reply":
    case "final_answer":
      return "model";
    case "tool_result":
      return "tool";
    case "guard_notice":
      return "guard";
    case "workflow_event":
      return "workflow";
    default:
      return "system";
  }
}

/** 旧记录没有证明字段：除 user_input 外全部不可信、不可见。 */
export function inferEnvelopeFromLegacy(role: string, content?: string): MessageEnvelope {
  if (role === "user") {
    return {
      messageKind: "user_input",
      uiVisible: true,
      trusted: true,
      source: "user",
      trustBasis: "user_authored",
    };
  }
  if (role === "tool") {
    return {
      messageKind: "tool_result",
      uiVisible: false,
      trusted: false,
      source: "tool",
    };
  }
  if (role === "assistant") {
    const action = tryParseAgentAction(content);
    if (action?.action === "tool") {
      return { messageKind: "tool_action", uiVisible: false, trusted: false, source: "model" };
    }
    if (action?.action === "final") {
      return { messageKind: "raw_model_final", uiVisible: false, trusted: false, source: "model" };
    }
    return { messageKind: "final_answer", uiVisible: false, trusted: false, source: "model" };
  }
  return {
    messageKind: "workflow_event",
    uiVisible: false,
    trusted: false,
    source: role === "system" ? "workflow" : "system",
  };
}

export function isContextTrustedMessage(envelope: MessageEnvelope): boolean {
  if (!envelope.trusted) return false;
  return (
    envelope.messageKind === "user_input" ||
    envelope.messageKind === "conversational_reply" ||
    envelope.messageKind === "final_answer" ||
    envelope.messageKind === "tool_result" ||
    envelope.messageKind === "guard_notice"
  );
}

export function isUiChatBubble(envelope: MessageEnvelope, role: string): boolean {
  if (role === "user") return envelope.trusted && envelope.uiVisible;
  return (
    envelope.trusted &&
    envelope.uiVisible &&
    (envelope.messageKind === "conversational_reply" || envelope.messageKind === "final_answer")
  );
}

function resolveTrustBasis(
  input: MessageEnvelopeInput,
  source: MessageSource,
): MessageTrustBasis | undefined {
  if (input.trustBasis) return input.trustBasis;
  if (input.messageKind === "user_input" && input.role === "user" && source === "user") {
    return "user_authored";
  }
  return undefined;
}

function hasValidTrustProof(input: {
  role?: string;
  kind: MessageKind;
  source: MessageSource;
  trustBasis?: MessageTrustBasis;
  runId?: string;
  ledgerBacked?: boolean;
}): boolean {
  if (input.kind === "user_input") {
    return input.role === "user" && input.source === "user" && input.trustBasis === "user_authored";
  }
  if (input.kind === "conversational_reply") {
    return (
      input.role === "assistant" &&
      input.source === "model" &&
      input.trustBasis === "conversational_reply"
    );
  }
  if (input.kind === "final_answer") {
    return (
      Boolean(input.runId) &&
      (input.source === "model" || input.source === "guard") &&
      input.trustBasis === "completion_guard"
    );
  }
  if (input.kind === "guard_notice") {
    return (
      input.role === "system" &&
      input.source === "guard" &&
      input.trustBasis === "completion_guard"
    );
  }
  if (input.kind === "tool_result") {
    return (
      input.role === "tool" &&
      input.source === "tool" &&
      input.trustBasis === "tool_ledger" &&
      input.ledgerBacked === true
    );
  }
  return false;
}

function tryParseAgentAction(content?: string): { action: string } | null {
  if (!content?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as { action?: string };
    if (parsed && typeof parsed.action === "string") return { action: parsed.action };
  } catch {
    // Legacy content remains untrusted.
  }
  return null;
}
