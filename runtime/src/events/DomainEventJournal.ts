import { randomUUID } from "node:crypto";

import {
  runtimeEventSchema,
  type RuntimeEvent,
} from "@ariadne/protocol/public";

import type { DatabaseManager } from "../context/DatabaseManager.js";

export type PublicAggregateType =
  | "runtime"
  | "run"
  | "companion"
  | "permission"
  | "plan_handoff"
  | "proposal"
  | "trace";

export interface PersistedDomainEvent {
  eventId: string;
  cursor: number;
  schemaVersion: "2.0";
  aggregateType: PublicAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  correlationId?: string;
  causationId?: string;
  eventType: string;
  event: unknown;
  occurredAt: string;
}

export class DomainEventJournal {
  constructor(private readonly database: DatabaseManager) {}

  append(input: {
    aggregateType: Exclude<PublicAggregateType, "run">;
    aggregateId: string;
    aggregateVersion?: number;
    correlationId?: string;
    causationId?: string;
    event: RuntimeEvent;
  }): PersistedDomainEvent {
    const event = runtimeEventSchema.parse(input.event);
    const connection = this.database.connection;
    const ownsTransaction = !connection.isTransaction;
    if (ownsTransaction) connection.exec("BEGIN IMMEDIATE");
    try {
      const aggregateVersion =
        input.aggregateVersion ?? this.nextAggregateVersion(input.aggregateType, input.aggregateId);
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      const inserted = connection
        .prepare(
          `INSERT INTO domain_event_outbox (
            event_id, schema_version, aggregate_type, aggregate_id,
            aggregate_version, correlation_id, causation_id, event_type,
            event_json, occurred_at
          ) VALUES (?, '2.0', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          input.aggregateType,
          input.aggregateId,
          aggregateVersion,
          input.correlationId ?? null,
          input.causationId ?? null,
          event.kind,
          JSON.stringify(event),
          occurredAt,
        );
      const persisted: PersistedDomainEvent = {
        eventId,
        cursor: Number(inserted.lastInsertRowid),
        schemaVersion: "2.0",
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion,
        correlationId: input.correlationId,
        causationId: input.causationId,
        eventType: event.kind,
        event,
        occurredAt,
      };
      if (ownsTransaction) connection.exec("COMMIT");
      return persisted;
    } catch (error) {
      if (ownsTransaction && connection.isTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  replay(options: { afterCursor: number; limit: number }): PersistedDomainEvent[] {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM domain_event_outbox
         WHERE cursor > ? ORDER BY cursor LIMIT ?`,
      )
      .all(options.afterCursor, options.limit) as Record<string, unknown>[];
    return rows.map(mapPersistedEvent);
  }

  currentCursor(): number {
    const row = this.database.connection
      .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM domain_event_outbox")
      .get() as { cursor: number };
    return Number(row.cursor);
  }

  acknowledge(consumerId: string, cursor: number): void {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO event_consumers(consumer_id, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(consumer_id) DO UPDATE SET
           cursor = MAX(event_consumers.cursor, excluded.cursor),
           updated_at = CASE
             WHEN excluded.cursor >= event_consumers.cursor THEN excluded.updated_at
             ELSE event_consumers.updated_at
           END`,
      )
      .run(consumerId, cursor, now);
  }

  consumerCursor(consumerId: string): number {
    const row = this.database.connection
      .prepare("SELECT cursor FROM event_consumers WHERE consumer_id = ?")
      .get(consumerId) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  private nextAggregateVersion(
    aggregateType: PublicAggregateType,
    aggregateId: string,
  ): number {
    const row = this.database.connection
      .prepare(
        `SELECT COALESCE(MAX(aggregate_version), 0) AS aggregate_version
         FROM domain_event_outbox
         WHERE aggregate_type = ? AND aggregate_id = ?`,
      )
      .get(aggregateType, aggregateId) as { aggregate_version: number };
    return Number(row.aggregate_version) + 1;
  }
}

function mapPersistedEvent(row: Record<string, unknown>): PersistedDomainEvent {
  return {
    eventId: String(row.event_id),
    cursor: Number(row.cursor),
    schemaVersion: "2.0",
    aggregateType: String(row.aggregate_type) as PublicAggregateType,
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    correlationId: optionalString(row.correlation_id),
    causationId: optionalString(row.causation_id),
    eventType: String(row.event_type),
    event: JSON.parse(String(row.event_json)) as unknown,
    occurredAt: String(row.occurred_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
