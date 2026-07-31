import type { DatabaseSync } from "node:sqlite";

import {
  AgentProposalSchema,
  type AgentCapability,
  type AgentProposal,
  type AgentProposalRisk,
} from "../assistant/AgentHandoffContracts.js";
import {
  CompanionAgentProposalOutboxPayloadSchema,
  type CompanionAgentProposalOutboxPayload,
  type CompanionAgentProposalOutboxState,
} from "./CompanionAgentProposalOutboxContracts.js";
import {
  mapCompanionMessageRow,
  serializeCompanionMessageEnvelope,
  type CompanionMessageRow,
} from "./CompanionMessagePersistence.js";
import type { CompanionMessage } from "./types.js";

interface ProposalOutboxRow {
  id: string;
  source_turn_id: string;
  assistant_message_id: string;
  session_id: string;
  payload_json: string;
  state: CompanionAgentProposalOutboxState;
  proposal_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
}

export interface CompanionAgentProposalOutboxEnqueueInput {
  payload: CompanionAgentProposalOutboxPayload;
  assistantMessageId?: string;
  content: string;
  modelName?: string;
  clientName?: string;
  metadata: Record<string, unknown>;
}

export interface CompanionAgentProposalOutboxEntry {
  id: string;
  payload: CompanionAgentProposalOutboxPayload;
  state: CompanionAgentProposalOutboxState;
  proposalId?: string;
  assistantMessage: CompanionMessage;
  attemptCount: number;
  lastErrorCode?: string;
}

export type CompanionAgentProposalOutboxClaim =
  | { status: "claimed"; entry: CompanionAgentProposalOutboxEntry }
  | { status: "in_progress" }
  | { status: "delivered"; entry: CompanionAgentProposalOutboxEntry };

/** Owns both local transactions around a cross-database Agent proposal dispatch. */
export class CompanionAgentProposalOutboxRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly storageRoot: string,
  ) {}

  recover(): void {
    const at = nowIso();
    this.db.prepare(
      `UPDATE companion_agent_proposal_outbox
       SET state='failed', last_error_code='service_restarted', updated_at=?
       WHERE state='dispatching'`,
    ).run(at);
    this.db.prepare(
      `UPDATE companion_messages
       SET metadata_json=json_set(COALESCE(metadata_json, '{}'),
         '$.agentProposalDeliveryState', 'failed',
         '$.agentProposalDeliveryErrorCode', 'service_restarted'),
         updated_at=?
       WHERE id IN (
         SELECT assistant_message_id FROM companion_agent_proposal_outbox
         WHERE state='failed' AND last_error_code='service_restarted'
       )`,
    ).run(at);
  }

  enqueue(input: CompanionAgentProposalOutboxEnqueueInput): CompanionAgentProposalOutboxEntry {
    const payload = CompanionAgentProposalOutboxPayloadSchema.parse(input.payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertSourceTurn(payload);
      const existing = this.findBySourceTurn(payload.sourceTurnId);
      if (existing) {
        const entry = this.mapEntry(existing);
        assertPayloadIdentity(entry.payload, payload);
        if (input.assistantMessageId && entry.assistantMessage.id !== input.assistantMessageId) {
          throw new Error("companion_agent_proposal_outbox_assistant_identity_conflict");
        }
        this.db.exec("COMMIT");
        return entry;
      }

      const assistantMessage = input.assistantMessageId
        ? this.interruptDraft(input.assistantMessageId, payload, input)
        : this.insertPendingMessage(payload, input);
      const id = crypto.randomUUID();
      const at = nowIso();
      this.db.prepare(
        `INSERT INTO companion_agent_proposal_outbox
          (id, source_turn_id, assistant_message_id, session_id, payload_json,
           state, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        id,
        payload.sourceTurnId,
        assistantMessage.id,
        payload.companionSessionId,
        JSON.stringify(payload),
        at,
        at,
      );
      this.touchSession(payload.companionSessionId, at);
      const created = this.getRow(id);
      if (!created) throw new Error("companion_agent_proposal_outbox_insert_lost");
      const entry = this.mapEntry(created);
      this.db.exec("COMMIT");
      return entry;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(id: string): CompanionAgentProposalOutboxClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRow(id);
      if (!current) throw new Error("companion_agent_proposal_outbox_missing");
      if (current.state === "delivered") {
        const message = this.getMessage(current.assistant_message_id);
        if (!current.proposal_id || !message) {
          throw new Error("companion_agent_proposal_outbox_delivered_incomplete");
        }
        this.db.exec("COMMIT");
        return { status: "delivered", entry: this.mapEntry(current) };
      }
      if (current.state === "dispatching") {
        this.db.exec("COMMIT");
        return { status: "in_progress" };
      }
      const changed = this.db.prepare(
        `UPDATE companion_agent_proposal_outbox
         SET state='dispatching', attempt_count=attempt_count+1,
             last_error_code=NULL, updated_at=?
         WHERE id=? AND state IN ('pending', 'failed')`,
      ).run(nowIso(), id);
      if (Number(changed.changes) !== 1) {
        throw new Error("companion_agent_proposal_outbox_claim_conflict");
      }
      const claimed = this.getRow(id);
      if (!claimed) throw new Error("companion_agent_proposal_outbox_claim_lost");
      const entry = this.mapEntry(claimed);
      this.db.exec("COMMIT");
      return { status: "claimed", entry };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(id: string, rawProposal: AgentProposal): {
    proposal: AgentProposal;
    assistantMessage: CompanionMessage;
  } {
    const proposal = AgentProposalSchema.parse(rawProposal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRow(id);
      if (!current) throw new Error("companion_agent_proposal_outbox_missing");
      const payload = this.parsePayload(current.payload_json);
      assertDeliveredProposal(payload, proposal);
      if (current.state === "delivered") {
        if (current.proposal_id !== proposal.id) {
          throw new Error("companion_agent_proposal_outbox_proposal_identity_conflict");
        }
        const existing = this.getMessage(current.assistant_message_id);
        if (!existing) throw new Error("companion_agent_proposal_outbox_message_missing");
        this.db.exec("COMMIT");
        return { proposal, assistantMessage: existing };
      }
      if (current.state !== "dispatching") {
        throw new Error("companion_agent_proposal_outbox_not_dispatching");
      }
      const message = this.getMessage(current.assistant_message_id);
      if (!message || message.status !== "interrupted") {
        throw new Error("companion_agent_proposal_outbox_pending_message_invalid");
      }
      const at = nowIso();
      const metadata: Record<string, unknown> = {
        ...(message.metadata ?? {}),
        responseType: "agent_proposal",
        agentProposalId: proposal.id,
        agentProposalDeliveryState: "delivered",
      };
      delete metadata.agentProposalDeliveryErrorCode;
      const messageUpdate = this.db.prepare(
        `UPDATE companion_messages
         SET status='completed', metadata_json=?, updated_at=?
         WHERE id=? AND status='interrupted'`,
      ).run(JSON.stringify(metadata), at, message.id);
      const outboxUpdate = this.db.prepare(
        `UPDATE companion_agent_proposal_outbox
         SET state='delivered', proposal_id=?, last_error_code=NULL, updated_at=?
         WHERE id=? AND state='dispatching'`,
      ).run(proposal.id, at, id);
      if (Number(messageUpdate.changes) !== 1 || Number(outboxUpdate.changes) !== 1) {
        throw new Error("companion_agent_proposal_outbox_completion_conflict");
      }
      this.touchSession(payload.companionSessionId, at);
      const completedMessage = this.getMessage(message.id);
      if (!completedMessage) throw new Error("companion_agent_proposal_outbox_message_missing");
      this.db.exec("COMMIT");
      return { proposal, assistantMessage: completedMessage };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  continueAssistantTurn(rawProposal: AgentProposal): CompanionMessage | null {
    const proposal = AgentProposalSchema.parse(rawProposal);
    if (!["approved", "executing", "waiting_permission", "waiting_plan_handoff"].includes(
      proposal.status,
    )) {
      return null;
    }
    const current = this.findByProposal(proposal.id);
    if (!current || current.state !== "delivered") return null;
    const payload = this.parsePayload(current.payload_json);
    assertProposalBinding(payload, proposal);
    const message = this.getMessage(current.assistant_message_id);
    if (
      !message
      || message.sessionId !== proposal.companionSessionId
      || message.role !== "assistant"
    ) {
      throw new Error("companion_agent_proposal_outbox_message_mismatch");
    }

    const at = nowIso();
    const metadata: Record<string, unknown> = {
      ...(message.metadata ?? {}),
      responseType: "agent_proposal",
      agentProposalId: proposal.id,
      agentProposalStatus: proposal.status,
      agentProposalDeliveryState: "delivered",
      ...(proposal.runId ? { agentRunId: proposal.runId } : {}),
    };
    this.db.prepare(
      `UPDATE companion_messages
       SET status='streaming', content_envelope_json=?, memory_eligible=0,
           metadata_json=?, updated_at=?
       WHERE id=?`,
    ).run(
      serializeCompanionMessageEnvelope("assistant", "streaming", message.id),
      JSON.stringify(metadata),
      at,
      message.id,
    );
    this.touchSession(message.sessionId, at);
    return this.getMessage(message.id);
  }

  fail(id: string, errorCode: string): void {
    const current = this.getRow(id);
    if (!current || current.state !== "dispatching") return;
    const message = this.getMessage(current.assistant_message_id);
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const code = stableErrorCode(errorCode);
      const changed = this.db.prepare(
        `UPDATE companion_agent_proposal_outbox
         SET state='failed', last_error_code=?, updated_at=?
         WHERE id=? AND state='dispatching'`,
      ).run(code, at, id);
      if (Number(changed.changes) === 1 && message) {
        this.db.prepare(
          `UPDATE companion_messages SET metadata_json=?, updated_at=? WHERE id=?`,
        ).run(JSON.stringify({
          ...(message.metadata ?? {}),
          responseType: "agent_proposal_delivery_pending",
          agentProposalDeliveryState: "failed",
          agentProposalDeliveryErrorCode: code,
        }), at, message.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverableIds(limit = 50): string[] {
    return (this.db.prepare(
      `SELECT id FROM companion_agent_proposal_outbox
       WHERE state IN ('pending', 'failed')
       ORDER BY created_at ASC LIMIT ?`,
    ).all(Math.max(1, Math.min(200, limit))) as Array<{ id: string }>).map((row) => row.id);
  }

  get(id: string): CompanionAgentProposalOutboxEntry | null {
    const row = this.getRow(id);
    return row ? this.mapEntry(row) : null;
  }

  private insertPendingMessage(
    payload: CompanionAgentProposalOutboxPayload,
    input: CompanionAgentProposalOutboxEnqueueInput,
  ): CompanionMessage {
    const id = crypto.randomUUID();
    const at = nowIso();
    this.db.prepare(
      `INSERT INTO companion_messages
        (id, session_id, role, content, status, content_envelope_json, memory_eligible,
         model_name, client_name, storage_root, created_at, updated_at, metadata_json)
       VALUES (?, ?, 'assistant', ?, 'interrupted', ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      payload.companionSessionId,
      input.content,
      serializeCompanionMessageEnvelope("assistant", "interrupted", id),
      input.modelName ?? null,
      input.clientName ?? null,
      this.storageRoot,
      at,
      at,
      JSON.stringify(pendingMetadata(input.metadata)),
    );
    const message = this.getMessage(id);
    if (!message) throw new Error("companion_agent_proposal_outbox_message_insert_lost");
    return message;
  }

  private interruptDraft(
    messageId: string,
    payload: CompanionAgentProposalOutboxPayload,
    input: CompanionAgentProposalOutboxEnqueueInput,
  ): CompanionMessage {
    const message = this.getMessage(messageId);
    if (
      !message
      || message.sessionId !== payload.companionSessionId
      || message.role !== "assistant"
      || message.status !== "streaming"
    ) {
      throw new Error("companion_agent_proposal_outbox_streaming_draft_invalid");
    }
    const at = nowIso();
    const changed = this.db.prepare(
      `UPDATE companion_messages
       SET content=?, status='interrupted', model_name=?, client_name=?,
           metadata_json=?, updated_at=?
       WHERE id=? AND status='streaming'`,
    ).run(
      input.content,
      input.modelName ?? message.modelName ?? null,
      input.clientName ?? message.clientName ?? null,
      JSON.stringify(pendingMetadata(input.metadata)),
      at,
      messageId,
    );
    if (Number(changed.changes) !== 1) {
      throw new Error("companion_agent_proposal_outbox_streaming_draft_conflict");
    }
    const interrupted = this.getMessage(messageId);
    if (!interrupted) throw new Error("companion_agent_proposal_outbox_message_missing");
    return interrupted;
  }

  private assertSourceTurn(payload: CompanionAgentProposalOutboxPayload): void {
    const source = this.getMessage(payload.sourceTurnId);
    if (
      !source
      || source.sessionId !== payload.companionSessionId
      || source.role !== "user"
      || source.status !== "completed"
      || source.content !== payload.originalRequest
    ) {
      throw new Error("companion_agent_proposal_outbox_source_turn_invalid");
    }
  }

  private mapEntry(row: ProposalOutboxRow): CompanionAgentProposalOutboxEntry {
    const message = this.getMessage(row.assistant_message_id);
    if (!message) throw new Error("companion_agent_proposal_outbox_message_missing");
    return {
      id: row.id,
      payload: this.parsePayload(row.payload_json),
      state: row.state,
      proposalId: row.proposal_id ?? undefined,
      assistantMessage: message,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code ?? undefined,
    };
  }

  private parsePayload(value: string): CompanionAgentProposalOutboxPayload {
    return CompanionAgentProposalOutboxPayloadSchema.parse(JSON.parse(value) as unknown);
  }

  private getMessage(id: string): CompanionMessage | null {
    const row = this.db.prepare(`SELECT * FROM companion_messages WHERE id=?`)
      .get(id) as CompanionMessageRow | undefined;
    return row ? mapCompanionMessageRow(row) : null;
  }

  private getRow(id: string): ProposalOutboxRow | undefined {
    return this.db.prepare(
      `SELECT id, source_turn_id, assistant_message_id, session_id, payload_json,
              state, proposal_id, attempt_count, last_error_code
       FROM companion_agent_proposal_outbox WHERE id=?`,
    ).get(id) as ProposalOutboxRow | undefined;
  }

  private findByProposal(proposalId: string): ProposalOutboxRow | undefined {
    return this.db.prepare(
      `SELECT * FROM companion_agent_proposal_outbox WHERE proposal_id=?`,
    ).get(proposalId) as ProposalOutboxRow | undefined;
  }

  private findBySourceTurn(sourceTurnId: string): ProposalOutboxRow | undefined {
    return this.db.prepare(
      `SELECT id, source_turn_id, assistant_message_id, session_id, payload_json,
              state, proposal_id, attempt_count, last_error_code
       FROM companion_agent_proposal_outbox WHERE source_turn_id=?`,
    ).get(sourceTurnId) as ProposalOutboxRow | undefined;
  }

  private touchSession(sessionId: string, at: string): void {
    this.db.prepare(`UPDATE companion_sessions SET updated_at=? WHERE id=?`).run(at, sessionId);
  }
}

function pendingMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    responseType: "agent_proposal_delivery_pending",
    agentProposalDeliveryState: "pending",
  };
}

function assertPayloadIdentity(
  actual: CompanionAgentProposalOutboxPayload,
  expected: CompanionAgentProposalOutboxPayload,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("companion_agent_proposal_outbox_payload_identity_conflict");
  }
}

function assertDeliveredProposal(
  payload: CompanionAgentProposalOutboxPayload,
  proposal: AgentProposal,
): void {
  if (
    proposal.status === "rejected"
    || proposal.status === "approved"
    || proposal.status === "executing"
  ) {
    throw new Error("companion_agent_proposal_outbox_delivered_proposal_invalid");
  }
  assertProposalBinding(payload, proposal);
}

function assertProposalBinding(
  payload: CompanionAgentProposalOutboxPayload,
  proposal: AgentProposal,
): void {
  if (
    proposal.sourceTurnId !== payload.sourceTurnId
    || proposal.companionSessionId !== payload.companionSessionId
    || proposal.originalRequest !== payload.originalRequest
    || proposal.reason !== payload.draft.reason
    || proposal.interpretedTask !== payload.draft.interpretedTask
    || !isSafeCapabilityNormalization(payload, proposal)
    || (payload.workspaceKey !== undefined && proposal.workspaceKey !== payload.workspaceKey)
  ) {
    throw new Error("companion_agent_proposal_outbox_proposal_binding_invalid");
  }
}

const CANONICAL_CAPABILITY_ORDER: readonly AgentCapability[] = [
  "file-read",
  "file-write",
  "browser",
  "shell",
];

/**
 * The Agent boundary deliberately normalizes the model's requested capability
 * ceiling against deterministic RunPolicy rules. Outbox identity therefore
 * validates that normalization instead of requiring the normalized proposal to
 * be byte-for-byte equal to untrusted model output.
 */
function isSafeCapabilityNormalization(
  payload: CompanionAgentProposalOutboxPayload,
  proposal: AgentProposal,
): boolean {
  const requested = new Set(payload.draft.requestedCapabilities);
  const delivered = new Set(proposal.requestedCapabilities);
  const canonicalDelivered = CANONICAL_CAPABILITY_ORDER.filter((capability) =>
    delivered.has(capability));

  if (JSON.stringify(proposal.requestedCapabilities) !== JSON.stringify(canonicalDelivered)) {
    return false;
  }
  if (proposal.requestedCapabilities.some((capability) =>
    capability !== "file-read" && !requested.has(capability))) {
    return false;
  }

  return proposal.risk === normalizedRisk(
    proposal.requestedCapabilities,
    payload.draft.risk,
  );
}

function normalizedRisk(
  capabilities: readonly AgentCapability[],
  requestedRisk: AgentProposalRisk,
): AgentProposalRisk {
  const hasSideEffects = capabilities.some((capability) => capability !== "file-read");
  if (!hasSideEffects) return "read-only";

  const hasDestructiveCapability = capabilities.some((capability) =>
    capability === "file-write" || capability === "shell");
  return requestedRisk === "destructive" && hasDestructiveCapability
    ? "destructive"
    : "write";
}

function stableErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : "AGENT_PROPOSAL_DISPATCH_FAILED";
}

function nowIso(): string {
  return new Date().toISOString();
}
