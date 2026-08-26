import type { AgentRunEvent } from '@ariadne/agent-core';

export interface AgentEventRow {
  event_id: string;
  command_id: string;
  run_id: string;
  run_version: number;
  sequence: number;
  occurred_at: string;
  event_json: string;
}

export function parseAgentEventRow(row: AgentEventRow): AgentRunEvent {
  const source = `agent_v3_events:${row.event_id}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json) as unknown;
  } catch (error) {
    throw storageCorruption(`${source}:invalid_json`, error);
  }
  if (!isRecord(parsed)) {
    throw storageCorruption(`${source}:event_not_object`);
  }
  const event = parsed as unknown as AgentRunEvent;
  if (
    event.eventId !== row.event_id
    || event.commandId !== row.command_id
    || event.runId !== row.run_id
    || event.runVersion !== row.run_version
    || event.sequence !== row.sequence
    || event.occurredAt !== row.occurred_at
    || !Number.isInteger(event.sequence)
    || event.sequence <= 0
    || !isTimestamp(event.occurredAt)
    || !isRecord(event.payload)
    || typeof event.payload.type !== 'string'
  ) {
    throw storageCorruption(`${source}:metadata_mismatch`);
  }
  return event;
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageCorruption(message: string, cause?: unknown): Error {
  return new Error(`agent_v3_storage_corruption:${message}`, { cause });
}
