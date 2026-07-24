import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "./DatabaseManager.js";
import { estimateTokens } from "./DatabaseManager.js";
import {
  resolveMessageEnvelope,
  type MessageEnvelope,
  type MessageEnvelopeInput,
} from "./messageEnvelope.js";
import { mapMessage, nowIso } from "./storeMappers.js";
import type { MessageRecord } from "./types.js";
import type { ToolCall } from "../model/types.js";

export interface MessageAppendMeta {
  clientName?: string;
  modelName?: string;
  envelope?: MessageEnvelopeInput;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export class MessageStore {
  constructor(private readonly db: DatabaseManager) {}

  append(
    sessionId: string,
    role: string,
    content: string,
    meta?: MessageAppendMeta,
  ): MessageRecord {
    const id = randomUUID();
    const ts = nowIso();
    const tokens = estimateTokens(content);
    const envelope = resolveMessageEnvelope({
      role,
      content,
      ...meta?.envelope,
    });
    this.db.connection
      .prepare(
        `INSERT INTO messages(
           id, session_id, role, content, token_estimate,
           client_name, model_name, message_kind, ui_visible, run_id,
           content_envelope_json, ledger_backed, outcome_class, outcome_kind,
           tool_name, tool_call_id, tool_calls_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        role,
        content,
        tokens,
        meta?.clientName ?? null,
        meta?.modelName ?? null,
        envelope.messageKind,
        envelope.uiVisible ? 1 : 0,
        envelope.runId ?? null,
        JSON.stringify(envelope.contentEnvelope),
        envelope.ledgerBacked == null ? null : envelope.ledgerBacked ? 1 : 0,
        envelope.outcomeClass ?? null,
        envelope.outcomeKind ?? null,
        meta?.toolName ?? null,
        meta?.toolCallId ?? null,
        meta?.toolCalls?.length ? JSON.stringify(meta.toolCalls) : null,
        ts,
      );
    this.db.upsertFts("messages_fts", id, content);
    return toMessageRecord({
      id,
      sessionId,
      role,
      content,
      tokens,
      meta,
      envelope,
      ts,
    });
  }

  markSummarized(messageIds: string[], summaryId: string): void {
    if (messageIds.length === 0) return;
    const stmt = this.db.connection.prepare(
      `UPDATE messages SET is_summarized=1, summary_id=? WHERE id=?`,
    );
    for (const id of messageIds) {
      stmt.run(summaryId, id);
    }
  }

  listBySession(sessionId: string, limit = 500): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  listRecent(sessionId: string, count: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, count) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  countInSession(sessionId: string): number {
    const row = this.db.connection
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`)
      .get(sessionId) as { c: number };
    return row.c;
  }

  getRange(sessionId: string, startId: string, endId: string): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages
         WHERE session_id=? AND created_at >= (SELECT created_at FROM messages WHERE id=?)
           AND created_at <= (SELECT created_at FROM messages WHERE id=?)
         ORDER BY created_at ASC`,
      )
      .all(sessionId, startId, endId) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  getUnsummarized(sessionId: string, summarizedEndId?: string): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM messages WHERE session_id=? AND is_summarized=0 ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    const unsummarized = rows.map(mapMessage);
    if (!summarizedEndId) return unsummarized;
    const row = this.db.connection
      .prepare(`SELECT created_at FROM messages WHERE id=?`)
      .get(summarizedEndId) as { created_at: string } | undefined;
    if (!row) return unsummarized;
    return unsummarized.filter((m) => m.createdAt > row.created_at);
  }

  getRecentUnsummarized(sessionId: string, limit: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? AND is_summarized=0
           ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  listRecentByRole(sessionId: string, role: string, limit: number): MessageRecord[] {
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id=? AND role=?
           ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, role, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }
}

function toMessageRecord(input: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  tokens: number;
  meta?: MessageAppendMeta;
  envelope: MessageEnvelope;
  ts: string;
}): MessageRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    tokenEstimate: input.tokens,
    isSummarized: false,
    clientName: input.meta?.clientName,
    modelName: input.meta?.modelName,
    messageKind: input.envelope.messageKind,
    uiVisible: input.envelope.uiVisible,
    contentEnvelope: input.envelope.contentEnvelope,
    runId: input.envelope.runId,
    ledgerBacked: input.envelope.ledgerBacked,
    outcomeClass: input.envelope.outcomeClass,
    outcomeKind: input.envelope.outcomeKind,
    toolName: input.meta?.toolName,
    toolCallId: input.meta?.toolCallId,
    toolCalls: input.meta?.toolCalls,
    createdAt: input.ts,
  };
}

export function enrichMessageRecord(record: MessageRecord): MessageRecord & { envelope: MessageEnvelope } {
  const envelope = resolveMessageEnvelope({
    role: record.role,
    content: record.content,
    messageKind: record.messageKind,
    uiVisible: record.uiVisible,
    contentEnvelope: record.contentEnvelope,
    runId: record.runId,
    ledgerBacked: record.ledgerBacked,
    outcomeClass: record.outcomeClass,
    outcomeKind: record.outcomeKind,
  });
  return {
    ...record,
    messageKind: envelope.messageKind,
    uiVisible: envelope.uiVisible,
    contentEnvelope: envelope.contentEnvelope,
    runId: envelope.runId,
    envelope,
  };
}
