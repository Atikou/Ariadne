import { z } from "zod";

import {
  AgentProposalDraftSchema,
  type AgentProposalDraft,
} from "../assistant/AgentProposalDraftContracts.js";

export const COMPANION_AGENT_PROPOSAL_OPEN = "<ariadne-agent-proposal>";
export const COMPANION_AGENT_PROPOSAL_CLOSE = "</ariadne-agent-proposal>";

export const CompanionModelMessageTurnSchema = z.object({
  kind: z.literal("message"),
  content: z.string(),
}).strict();

export const CompanionModelProposalTurnSchema = z.object({
  kind: z.literal("agent_proposal"),
  draft: AgentProposalDraftSchema,
}).strict();

export const CompanionModelTurnSchema = z.discriminatedUnion("kind", [
  CompanionModelMessageTurnSchema,
  CompanionModelProposalTurnSchema,
]);
export type CompanionModelTurn = z.infer<typeof CompanionModelTurnSchema>;

export class CompanionTurnProtocolError extends Error {
  readonly code = "COMPANION_TURN_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CompanionTurnProtocolError";
  }
}

export class CompanionEmptyResponseError extends Error {
  readonly code = "COMPANION_EMPTY_RESPONSE";

  constructor() {
    super("模型完成了请求，但没有返回可展示的最终内容");
    this.name = "CompanionEmptyResponseError";
  }
}

export function renderAgentProposalEnvelope(draft: AgentProposalDraft): string {
  const parsed = AgentProposalDraftSchema.parse(draft);
  return `${COMPANION_AGENT_PROPOSAL_OPEN}\n${JSON.stringify(parsed)}\n${COMPANION_AGENT_PROPOSAL_CLOSE}`;
}

export function parseCompanionModelTurn(
  raw: string,
  options: { protocolEnabled?: boolean; agentProposalEnabled: boolean },
): CompanionModelTurn {
  if (options.protocolEnabled === false) {
    return CompanionModelTurnSchema.parse({ kind: "message", content: raw });
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new CompanionEmptyResponseError();
  const mentionsProtocol = trimmed.includes(COMPANION_AGENT_PROPOSAL_OPEN)
    || trimmed.includes(COMPANION_AGENT_PROPOSAL_CLOSE);
  if (!mentionsProtocol) {
    return CompanionModelTurnSchema.parse({ kind: "message", content: raw });
  }
  if (!options.agentProposalEnabled) {
    throw new CompanionTurnProtocolError("当前对话不能创建持久化 Agent 提案");
  }
  if (
    !trimmed.startsWith(COMPANION_AGENT_PROPOSAL_OPEN)
    || !trimmed.endsWith(COMPANION_AGENT_PROPOSAL_CLOSE)
  ) {
    throw new CompanionTurnProtocolError("Agent 提案必须是模型响应中的唯一完整信封");
  }
  const json = trimmed.slice(
    COMPANION_AGENT_PROPOSAL_OPEN.length,
    trimmed.length - COMPANION_AGENT_PROPOSAL_CLOSE.length,
  ).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(json) as unknown;
  } catch {
    throw new CompanionTurnProtocolError("Agent 提案不是合法 JSON");
  }
  const parsed = AgentProposalDraftSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CompanionTurnProtocolError("Agent 提案字段不符合严格契约");
  }
  return CompanionModelTurnSchema.parse({ kind: "agent_proposal", draft: parsed.data });
}

/**
 * Holds only the suffix that could still become a reserved envelope marker.
 * Once a marker starts, all remaining protocol bytes stay private until parsing.
 */
export class CompanionTurnStreamDecoder {
  private raw = "";
  private forwardedLength = 0;
  private protocolStart: number | undefined;

  constructor(
    private readonly options: {
      protocolEnabled?: boolean;
      agentProposalEnabled: boolean;
      onMessageToken(delta: string): void;
    },
  ) {}

  get rawText(): string {
    return this.raw;
  }

  get publicPartial(): string {
    return this.raw.slice(0, this.forwardedLength);
  }

  push(delta: string): void {
    if (!delta) return;
    this.raw += delta;
    if (this.options.protocolEnabled === false) {
      this.flushTo(this.raw.length);
      return;
    }
    if (this.protocolStart !== undefined) return;

    const markerIndex = firstMarkerIndex(this.raw, this.forwardedLength);
    if (markerIndex !== -1) {
      this.flushTo(markerIndex);
      this.protocolStart = markerIndex;
      return;
    }
    const heldLength = longestMarkerPrefixSuffix(this.raw);
    this.flushTo(this.raw.length - heldLength);
  }

  finish(fallbackContent: string): CompanionModelTurn {
    if (!this.raw && fallbackContent) this.raw = fallbackContent;
    const turn = parseCompanionModelTurn(this.raw, this.options);
    if (turn.kind === "message") this.flushTo(this.raw.length);
    return turn;
  }

  private flushTo(end: number): void {
    if (end <= this.forwardedLength) return;
    const delta = this.raw.slice(this.forwardedLength, end);
    this.forwardedLength = end;
    if (delta) this.options.onMessageToken(delta);
  }
}

function firstMarkerIndex(value: string, from: number): number {
  const searchFrom = Math.max(0, from - Math.max(
    COMPANION_AGENT_PROPOSAL_OPEN.length,
    COMPANION_AGENT_PROPOSAL_CLOSE.length,
  ));
  const open = value.indexOf(COMPANION_AGENT_PROPOSAL_OPEN, searchFrom);
  const close = value.indexOf(COMPANION_AGENT_PROPOSAL_CLOSE, searchFrom);
  if (open === -1) return close;
  if (close === -1) return open;
  return Math.min(open, close);
}

function longestMarkerPrefixSuffix(value: string): number {
  const markers = [COMPANION_AGENT_PROPOSAL_OPEN, COMPANION_AGENT_PROPOSAL_CLOSE];
  const max = Math.min(value.length, Math.max(...markers.map((marker) => marker.length - 1)));
  for (let length = max; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (markers.some((marker) => marker.startsWith(suffix))) return length;
  }
  return 0;
}
