import { randomUUID } from "node:crypto";

import {
  runtimeEventEnvelopeSchema,
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
  | "projection"
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

export interface AppendDomainEventInput {
  aggregateType: PublicAggregateType;
  aggregateId: string;
  aggregateVersion?: number;
  /**
   * Stable producer identity. External outbox publishers must supply this
   * together with aggregateVersion and occurredAt so append/ack crash replay
   * cannot duplicate the public projection.
   */
  eventId?: string;
  occurredAt?: string;
  correlationId?: string;
  causationId?: string;
  event: RuntimeEvent;
}

export class DomainEventJournal {
  constructor(private readonly database: DatabaseManager) {}

  append(input: AppendDomainEventInput): PersistedDomainEvent {
    const event = runtimeEventSchema.parse(input.event);
    assertAppendIdentity({ ...input, event });
    const connection = this.database.connection;
    const ownsTransaction = !connection.isTransaction;
    if (ownsTransaction) connection.exec("BEGIN IMMEDIATE");
    try {
      const eventId = input.eventId ?? randomUUID();
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const eventJson = JSON.stringify(event);
      if (input.aggregateVersion !== undefined) {
        assertPersistableEnvelope({
          ...input,
          eventId,
          aggregateVersion: input.aggregateVersion,
          occurredAt,
          event,
        });
      }
      const existingById = this.findByEventId(eventId);
      if (existingById) {
        const replay = assertExactReplay(existingById, {
          ...input,
          eventId,
          occurredAt,
          eventJson,
        });
        if (ownsTransaction) connection.exec("COMMIT");
        return replay;
      }
      const aggregateVersion =
        input.aggregateVersion ?? this.nextAggregateVersion(input.aggregateType, input.aggregateId);
      assertPersistableEnvelope({
        ...input,
        eventId,
        aggregateVersion,
        occurredAt,
        event,
      });
      const existingAggregateVersion = this.findByAggregateVersion(
        input.aggregateType,
        input.aggregateId,
        aggregateVersion,
      );
      if (existingAggregateVersion) {
        throw new Error(
          `domain_event_aggregate_version_conflict:${input.aggregateType}:`
          + `${input.aggregateId}:${String(aggregateVersion)}`,
        );
      }
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
          eventJson,
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

  /**
   * Establishes the first snapshot boundary without overwriting an existing
   * delivery cursor. Later process starts resume from the last acknowledged
   * event instead of skipping directly to the journal tail.
   */
  initializeConsumer(consumerId: string, initialCursor: number): number {
    if (!consumerId.trim()) throw new Error("domain_event_consumer_id_required");
    if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) {
      throw new Error("domain_event_consumer_cursor_invalid");
    }
    const connection = this.database.connection;
    const ownsTransaction = !connection.isTransaction;
    if (ownsTransaction) connection.exec("BEGIN IMMEDIATE");
    try {
      connection.prepare(
        `INSERT OR IGNORE INTO event_consumers(consumer_id, cursor, updated_at)
         VALUES (?, ?, ?)`,
      ).run(consumerId, initialCursor, new Date().toISOString());
      const cursor = this.consumerCursor(consumerId);
      if (ownsTransaction) connection.exec("COMMIT");
      return cursor;
    } catch (error) {
      if (ownsTransaction && connection.isTransaction) connection.exec("ROLLBACK");
      throw error;
    }
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

  private findByEventId(eventId: string): PersistedDomainEvent | null {
    const row = this.database.connection
      .prepare("SELECT * FROM domain_event_outbox WHERE event_id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row ? mapPersistedEvent(row) : null;
  }

  private findByAggregateVersion(
    aggregateType: PublicAggregateType,
    aggregateId: string,
    aggregateVersion: number,
  ): PersistedDomainEvent | null {
    const row = this.database.connection
      .prepare(
        `SELECT * FROM domain_event_outbox
         WHERE aggregate_type = ? AND aggregate_id = ? AND aggregate_version = ?
         LIMIT 1`,
      )
      .get(aggregateType, aggregateId, aggregateVersion) as
        | Record<string, unknown>
        | undefined;
    return row ? mapPersistedEvent(row) : null;
  }
}

function assertAppendIdentity(input: AppendDomainEventInput): void {
  assertCanonicalPublicId(input.aggregateId, "aggregate_id");
  if (
    input.aggregateVersion !== undefined
    && (!Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion <= 0)
  ) {
    throw new Error("domain_event_aggregate_version_invalid");
  }
  const hasExternalIdentity = input.eventId !== undefined || input.occurredAt !== undefined;
  if (
    hasExternalIdentity
    && (
      input.eventId === undefined
      || input.occurredAt === undefined
      || input.aggregateVersion === undefined
    )
  ) {
    throw new Error("domain_event_stable_identity_incomplete");
  }
  if (input.eventId !== undefined) assertCanonicalPublicId(input.eventId, "id");
  if (input.correlationId !== undefined) {
    assertCanonicalPublicId(input.correlationId, "correlation_id");
  }
  if (input.causationId !== undefined) {
    assertCanonicalPublicId(input.causationId, "causation_id");
  }
  if (
    input.occurredAt !== undefined
    && !Number.isFinite(Date.parse(input.occurredAt))
  ) {
    throw new Error("domain_event_occurred_at_invalid");
  }
  if (input.aggregateType === "run" || input.event.kind === "run.changed") {
    if (
      input.aggregateType !== "run"
      || input.event.kind !== "run.changed"
      || input.aggregateId !== input.event.run.runId
      || input.aggregateVersion !== input.event.run.aggregateVersion
    ) {
      throw new Error("domain_event_run_identity_mismatch");
    }
  }
}

function assertCanonicalPublicId(value: string, field: string): void {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new Error(`domain_event_${field}_invalid`);
  }
}

/**
 * Validate the exact envelope metadata before it can become an outbox row.
 * The dispatcher must never discover a schema error only after persistence,
 * because one invalid cursor would permanently block every later live event.
 */
function assertPersistableEnvelope(input: {
  readonly eventId: string;
  readonly aggregateType: PublicAggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly event: RuntimeEvent;
}): void {
  const parsed = runtimeEventEnvelopeSchema.parse({
    eventId: input.eventId,
    cursor: 1,
    schemaVersion: "2.0",
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: input.occurredAt,
    event: input.event,
  });
  if (
    parsed.eventId !== input.eventId
    || parsed.aggregateId !== input.aggregateId
    || parsed.correlationId !== input.correlationId
    || parsed.causationId !== input.causationId
  ) {
    throw new Error("domain_event_envelope_identity_noncanonical");
  }
}

function assertExactReplay(
  existing: PersistedDomainEvent,
  expected: AppendDomainEventInput & {
    eventId: string;
    occurredAt: string;
    eventJson: string;
  },
): PersistedDomainEvent {
  if (
    existing.aggregateType !== expected.aggregateType
    || existing.aggregateId !== expected.aggregateId
    || (
      expected.aggregateVersion !== undefined
      && existing.aggregateVersion !== expected.aggregateVersion
    )
    || existing.correlationId !== expected.correlationId
    || existing.causationId !== expected.causationId
    || existing.eventType !== expected.event.kind
    || existing.occurredAt !== expected.occurredAt
    || JSON.stringify(existing.event) !== expected.eventJson
  ) {
    throw new Error(`domain_event_id_conflict:${expected.eventId}`);
  }
  return existing;
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
