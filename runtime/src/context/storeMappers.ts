import type { MessageRecord, SessionRecord } from "./types.js";
import type { MessageKind, MessageSource, MessageTrustBasis } from "./messageEnvelope.js";
import { resolveMessageEnvelope } from "./messageEnvelope.js";
import type { ToolCall } from "../model/types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status === "archived" ? "archived" : "active",
    projectId: row.project_id ? String(row.project_id) : undefined,
    workspaceKey: row.workspace_key ? String(row.workspace_key) : undefined,
    lastMessageId: row.last_message_id ? String(row.last_message_id) : undefined,
    activeTaskId: row.active_task_id ? String(row.active_task_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapMessage(row: Record<string, unknown>): MessageRecord {
  const role = String(row.role);
  const content = String(row.content);
  const messageKind = row.message_kind ? (String(row.message_kind) as MessageKind) : undefined;
  const envelope = resolveMessageEnvelope({
    role,
    content,
    messageKind,
    uiVisible: row.ui_visible != null ? Number(row.ui_visible) === 1 : undefined,
    trusted: row.trusted != null ? Number(row.trusted) === 1 : undefined,
    source: row.source ? (String(row.source) as MessageSource) : undefined,
    trustBasis: row.trust_basis ? (String(row.trust_basis) as MessageTrustBasis) : undefined,
    runId: row.run_id ? String(row.run_id) : undefined,
    ledgerBacked: row.ledger_backed != null ? Number(row.ledger_backed) === 1 : undefined,
    outcomeClass: row.outcome_class ? String(row.outcome_class) : undefined,
    outcomeKind: row.outcome_kind ? String(row.outcome_kind) : undefined,
  });
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role,
    content,
    tokenEstimate: Number(row.token_estimate ?? 0),
    isSummarized: Number(row.is_summarized ?? 0) === 1,
    summaryId: row.summary_id ? String(row.summary_id) : undefined,
    clientName: row.client_name ? String(row.client_name) : undefined,
    modelName: row.model_name ? String(row.model_name) : undefined,
    messageKind: envelope.messageKind,
    uiVisible: envelope.uiVisible,
    trusted: envelope.trusted,
    source: envelope.source,
    trustBasis: envelope.trustBasis,
    runId: envelope.runId,
    ledgerBacked:
      row.ledger_backed != null ? Number(row.ledger_backed) === 1 : undefined,
    outcomeClass: row.outcome_class ? String(row.outcome_class) : undefined,
    outcomeKind: row.outcome_kind ? String(row.outcome_kind) : undefined,
    toolName: row.tool_name ? String(row.tool_name) : undefined,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
    toolCalls: parseToolCalls(row.tool_calls_json),
    createdAt: String(row.created_at),
  };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const calls = parsed.filter((call): call is ToolCall => {
      if (call == null || typeof call !== "object") return false;
      const candidate = call as Partial<ToolCall>;
      return typeof candidate.id === "string" && typeof candidate.name === "string";
    });
    return calls.length > 0 ? calls : undefined;
  } catch {
    return undefined;
  }
}
