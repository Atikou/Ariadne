import type { DatabaseSync } from "node:sqlite";

import type { AgentExecutionOutcome } from "../assistant/AgentHandoffContracts.js";
import {
  mapCompanionMessageRow,
  type CompanionMessageRow,
} from "./CompanionMessagePersistence.js";
import type { CompanionMessage } from "./types.js";

interface AgentResultPresentationRow {
  projection_key: string;
  proposal_id: string;
  run_id: string | null;
  outcome_status: AgentExecutionOutcome["status"];
  session_id: string;
  source_turn_id: string;
  state: "generating" | "completed" | "failed";
  presentation_source: "model" | "fallback" | null;
  message_id: string | null;
}

export interface CompanionAgentResultProjectionIdentity {
  projectionKey: string;
  proposalId: string;
  runId?: string;
  outcomeStatus: AgentExecutionOutcome["status"];
  sessionId: string;
  sourceTurnId: string;
}

export type CompanionAgentResultProjectionClaim =
  | { status: "claimed" }
  | { status: "in_progress" }
  | { status: "completed"; source: "model" | "fallback"; message: CompanionMessage };

export interface CompanionAgentResultPresentationCompletion {
  identity: CompanionAgentResultProjectionIdentity;
  source: "model" | "fallback";
  content: string;
  modelName?: string;
  clientName?: string;
  metadata: Record<string, unknown>;
}

/** Owns the transactional projection from one Agent outcome to one Companion message. */
export class CompanionAgentResultPresentationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly storageRoot: string,
  ) {}

  recover(): void {
    this.db.prepare(
      `UPDATE companion_agent_result_presentations
       SET state='failed', last_error_code='service_restarted', updated_at=?
       WHERE state='generating'`,
    ).run(nowIso());
  }

  claim(input: CompanionAgentResultProjectionIdentity): CompanionAgentResultProjectionClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getProjection(input.projectionKey);
      if (current) {
        assertProjectionIdentity(current, input);
        if (current.state === "completed") {
          const message = current.message_id ? this.getMessage(current.message_id) : null;
          if (!message || !current.presentation_source) {
            throw new Error("companion_agent_result_projection_completed_without_message");
          }
          this.db.exec("COMMIT");
          return { status: "completed", source: current.presentation_source, message };
        }
        if (current.state === "generating") {
          this.db.exec("COMMIT");
          return { status: "in_progress" };
        }
        this.db.prepare(
          `UPDATE companion_agent_result_presentations
           SET state='generating', attempt_count=attempt_count+1,
               last_error_code=NULL, updated_at=?
           WHERE projection_key=? AND state='failed'`,
        ).run(nowIso(), input.projectionKey);
      } else {
        const at = nowIso();
        this.db.prepare(
          `INSERT INTO companion_agent_result_presentations
            (projection_key, proposal_id, run_id, outcome_status, session_id,
             source_turn_id, state, attempt_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'generating', 1, ?, ?)`,
        ).run(
          input.projectionKey,
          input.proposalId,
          input.runId ?? null,
          input.outcomeStatus,
          input.sessionId,
          input.sourceTurnId,
          at,
          at,
        );
      }
      this.db.exec("COMMIT");
      return { status: "claimed" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(input: CompanionAgentResultPresentationCompletion): CompanionMessage {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getProjection(input.identity.projectionKey);
      if (!current) throw new Error("companion_agent_result_projection_not_claimed");
      assertProjectionIdentity(current, input.identity);
      if (current.state === "completed") {
        const existing = current.message_id ? this.getMessage(current.message_id) : null;
        if (!existing) throw new Error("companion_agent_result_projection_message_missing");
        this.db.exec("COMMIT");
        return existing;
      }
      if (current.state !== "generating") {
        throw new Error("companion_agent_result_projection_not_generating");
      }

      const message = this.insertMessage(input);
      const changed = this.db.prepare(
        `UPDATE companion_agent_result_presentations
         SET state='completed', presentation_source=?, message_id=?,
             last_error_code=NULL, updated_at=?
         WHERE projection_key=? AND state='generating'`,
      ).run(input.source, message.id, nowIso(), input.identity.projectionKey);
      if (Number(changed.changes) !== 1) {
        throw new Error("companion_agent_result_projection_completion_conflict");
      }
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  fail(projectionKey: string, errorCode: string): void {
    this.db.prepare(
      `UPDATE companion_agent_result_presentations
       SET state='failed', last_error_code=?, updated_at=?
       WHERE projection_key=? AND state='generating'`,
    ).run(errorCode.slice(0, 200), nowIso(), projectionKey);
  }

  private insertMessage(input: CompanionAgentResultPresentationCompletion): CompanionMessage {
    const id = crypto.randomUUID();
    const at = nowIso();
    this.db.prepare(
      `INSERT INTO companion_messages
        (id, session_id, role, content, status, trusted, memory_eligible,
         model_name, client_name, storage_root, created_at, updated_at, metadata_json)
       VALUES (?, ?, 'assistant', ?, 'completed', 1, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.identity.sessionId,
      input.content,
      input.modelName ?? null,
      input.clientName ?? null,
      this.storageRoot,
      at,
      at,
      JSON.stringify(input.metadata),
    );
    this.db.prepare(`UPDATE companion_sessions SET updated_at=? WHERE id=?`)
      .run(at, input.identity.sessionId);
    const message = this.getMessage(id);
    if (!message) throw new Error("companion_agent_result_projection_message_missing");
    return message;
  }

  private getMessage(id: string): CompanionMessage | null {
    const row = this.db.prepare(`SELECT * FROM companion_messages WHERE id=?`)
      .get(id) as CompanionMessageRow | undefined;
    return row ? mapCompanionMessageRow(row) : null;
  }

  private getProjection(projectionKey: string): AgentResultPresentationRow | undefined {
    return this.db.prepare(
      `SELECT projection_key, proposal_id, run_id, outcome_status, session_id,
              source_turn_id, state, presentation_source, message_id
       FROM companion_agent_result_presentations WHERE projection_key=?`,
    ).get(projectionKey) as AgentResultPresentationRow | undefined;
  }
}

function assertProjectionIdentity(
  row: AgentResultPresentationRow,
  input: CompanionAgentResultProjectionIdentity,
): void {
  if (
    row.projection_key !== input.projectionKey
    || row.proposal_id !== input.proposalId
    || row.run_id !== (input.runId ?? null)
    || row.outcome_status !== input.outcomeStatus
    || row.session_id !== input.sessionId
    || row.source_turn_id !== input.sourceTurnId
  ) {
    throw new Error("companion_agent_result_projection_identity_conflict");
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
