import type { ChatRole } from "../model/types.js";
import type {
  ContentDataSensitivity,
  ContentEgressTarget,
  ContentEnvelope,
  ContentOrigin,
  InstructionAuthority,
  IntegrityEvidenceKind,
} from "../core/ContentEnvelope.js";

export type {
  ContentDataSensitivity,
  ContentEgressTarget,
  ContentEnvelope,
  ContentOrigin,
  InstructionAuthority,
  IntegrityEvidenceKind,
} from "../core/ContentEnvelope.js";

export type MessageKind =
  | "user_input"
  | "tool_action"
  | "conversational_reply"
  | "final_answer"
  | "raw_model_final"
  | "tool_result"
  | "workflow_event"
  | "guard_notice";

export interface MessageEnvelope {
  messageKind: MessageKind;
  uiVisible: boolean;
  contentEnvelope: ContentEnvelope;
  runId?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export interface MessageEnvelopeInput {
  role?: ChatRole | string;
  messageKind?: MessageKind;
  uiVisible?: boolean;
  contentEnvelope?: ContentEnvelope;
  runId?: string;
  content?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
}

export function resolveMessageEnvelope(input: MessageEnvelopeInput): MessageEnvelope {
  if (!input.messageKind) return inferEnvelopeFromLegacy(input.role ?? "system", input.content);
  const contentEnvelope = input.contentEnvelope ?? defaultContentEnvelope(
    input.messageKind,
    input.role,
    input.runId,
  );
  const uiEligible =
    input.messageKind === "user_input" ||
    input.messageKind === "conversational_reply" ||
    input.messageKind === "final_answer";
  const verified = isVerifiedContent(contentEnvelope);

  return {
    messageKind: input.messageKind,
    uiVisible: verified && uiEligible && (input.uiVisible ?? defaultUiVisible(input.messageKind)),
    contentEnvelope,
    runId: input.runId ?? contentEnvelope.provenance.runId,
    ledgerBacked: input.ledgerBacked,
    outcomeClass: input.outcomeClass,
    outcomeKind: input.outcomeKind,
  };
}

export function createContentEnvelope(input: {
  origin: ContentOrigin;
  evidence: IntegrityEvidenceKind;
  verified: boolean;
  instructionAuthority?: InstructionAuthority;
  dataSensitivity?: ContentDataSensitivity;
  externalContent?: boolean;
  egressAllowed?: ContentEgressTarget[];
  provenance?: ContentEnvelope["provenance"];
}): ContentEnvelope {
  const authority = input.instructionAuthority ?? defaultInstructionAuthority(input.origin);
  if (input.externalContent === true && authority !== "data") {
    throw new Error("external_content_cannot_hold_instruction_authority");
  }
  return {
    origin: input.origin,
    provenance: { ...(input.provenance ?? {}) },
    integrityEvidence: { kind: input.evidence, verified: input.verified },
    instructionAuthority: authority,
    dataSensitivity: input.dataSensitivity ?? "workspace",
    externalContent: input.externalContent ?? isExternalOrigin(input.origin),
    egressAllowed: [...(input.egressAllowed ?? [])],
  };
}

export function isVerifiedContent(envelope: ContentEnvelope): boolean {
  if (!envelope.integrityEvidence.verified) return false;
  if (envelope.externalContent && envelope.instructionAuthority !== "data") return false;
  switch (envelope.integrityEvidence.kind) {
    case "user_authored":
      return envelope.origin === "user" && envelope.instructionAuthority === "user";
    case "conversational_reply":
      return envelope.origin === "model" && envelope.instructionAuthority === "data";
    case "completion_guard":
      return (
        (envelope.origin === "model" || envelope.origin === "guard") &&
        (envelope.instructionAuthority === "data" || envelope.instructionAuthority === "system")
      );
    case "tool_ledger":
      return envelope.origin === "tool" && envelope.instructionAuthority === "data";
    case "host_policy":
      return (
        ((envelope.origin === "system" || envelope.origin === "guard") &&
          envelope.instructionAuthority === "system") ||
        (envelope.origin === "workspace" &&
          ["workspace_root", "target_directory", "skill"].includes(
            envelope.instructionAuthority,
          ))
      );
    default:
      return false;
  }
}

export function defaultUiVisible(kind: MessageKind): boolean {
  return kind === "user_input" || kind === "conversational_reply" || kind === "final_answer";
}

export function inferEnvelopeFromLegacy(role: string, content?: string): MessageEnvelope {
  if (role === "user") {
    return {
      messageKind: "user_input",
      uiVisible: true,
      contentEnvelope: createContentEnvelope({
        origin: "user",
        evidence: "user_authored",
        verified: true,
        instructionAuthority: "user",
        externalContent: false,
        egressAllowed: ["model"],
      }),
    };
  }
  const messageKind = role === "tool"
    ? "tool_result"
    : role === "assistant"
      ? tryParseAgentAction(content)?.action === "tool"
        ? "tool_action"
        : tryParseAgentAction(content)?.action === "final"
          ? "raw_model_final"
          : "final_answer"
      : "workflow_event";
  return {
    messageKind,
    uiVisible: false,
    contentEnvelope: createContentEnvelope({
      origin: role === "tool" ? "tool" : role === "assistant" ? "model" : "workflow",
      evidence: "unverified",
      verified: false,
      instructionAuthority: "data",
      externalContent: true,
      egressAllowed: [],
    }),
  };
}

export function isContextVerifiedMessage(envelope: MessageEnvelope): boolean {
  if (!isVerifiedContent(envelope.contentEnvelope)) return false;
  return (
    envelope.messageKind === "user_input" ||
    envelope.messageKind === "conversational_reply" ||
    envelope.messageKind === "final_answer" ||
    envelope.messageKind === "tool_result" ||
    envelope.messageKind === "guard_notice"
  );
}

export function isVerifiedUiChatBubble(envelope: MessageEnvelope, role: string): boolean {
  if (role === "user") return isVerifiedContent(envelope.contentEnvelope) && envelope.uiVisible;
  return (
    isVerifiedContent(envelope.contentEnvelope) &&
    envelope.uiVisible &&
    (envelope.messageKind === "conversational_reply" || envelope.messageKind === "final_answer")
  );
}

function defaultContentEnvelope(
  kind: MessageKind,
  role: string | undefined,
  runId: string | undefined,
): ContentEnvelope {
  if (kind === "user_input" && role === "user") {
    return createContentEnvelope({
      origin: "user",
      evidence: "user_authored",
      verified: true,
      instructionAuthority: "user",
      externalContent: false,
      egressAllowed: ["model"],
      provenance: { runId },
    });
  }
  return createContentEnvelope({
    origin: kind === "tool_result" ? "tool" : role === "assistant" ? "model" : "workflow",
    evidence: "unverified",
    verified: false,
    instructionAuthority: "data",
    externalContent: true,
    egressAllowed: [],
    provenance: { runId },
  });
}

function defaultInstructionAuthority(origin: ContentOrigin): InstructionAuthority {
  if (origin === "system" || origin === "guard") return "system";
  if (origin === "user") return "user";
  return "data";
}

function isExternalOrigin(origin: ContentOrigin): boolean {
  return ["workspace", "tool", "web", "command", "diff", "mcp", "subagent", "model"].includes(origin);
}

function tryParseAgentAction(content?: string): { action: string } | null {
  if (!content?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as { action?: string };
    return parsed && typeof parsed.action === "string" ? { action: parsed.action } : null;
  } catch {
    return null;
  }
}
