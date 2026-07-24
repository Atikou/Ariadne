import { randomUUID } from "node:crypto";

import type { DatabaseManager } from "../context/DatabaseManager.js";
import type {
  RunAggregate,
  RunAggregateState,
  RunAggregateStatus,
  RunCheckpoint,
  RunCheckpointStage,
  RunCommand,
  RunRecoveryStatus,
  RunWaitReason,
  RuntimeDomainEventEnvelope,
  ToolLedgerEntry,
} from "./runAggregateTypes.js";

export class ConcurrentRunModificationError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Run ${runId} has aggregate version ${actualVersion}; expected ${expectedVersion}.`,
    );
    this.name = "ConcurrentRunModificationError";
  }
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly runId: string,
    readonly from: RunAggregateStatus,
    readonly to: RunAggregateStatus,
  ) {
    super(`Run ${runId} cannot transition from ${from} to ${to}.`);
    this.name = "IllegalRunTransitionError";
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} does not exist.`);
    this.name = "RunNotFoundError";
  }
}

const TERMINAL_STATUSES = new Set<RunAggregateStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<RunAggregateStatus, ReadonlySet<RunAggregateStatus>>> = {
  pending: new Set(["running", "cancelled", "recovery_required"]),
  running: new Set([
    "running",
    "blocked",
    "waiting_confirmation",
    "waiting_plan_handoff",
    "paused",
    "recovery_required",
    "completed",
    "failed",
    "cancelled",
  ]),
  blocked: new Set(["running", "recovery_required", "failed", "cancelled"]),
  waiting_confirmation: new Set(["running", "recovery_required", "failed", "cancelled"]),
  waiting_plan_handoff: new Set(["running", "recovery_required", "failed", "cancelled"]),
  paused: new Set(["running", "recovery_required", "cancelled"]),
  recovery_required: new Set(["running", "paused", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

interface RunMutation {
  status: RunAggregateStatus;
  checkpointStage: RunCheckpointStage;
  recoveryStatus: RunRecoveryStatus;
  waitReason?: RunWaitReason;
  result?: unknown;
  error?: string;
  eventKind: string;
  state?: RunAggregateState;
}

export class RunAggregateRepository {
  constructor(private readonly database: DatabaseManager) {}

  usesConnection(connection: DatabaseManager["connection"]): boolean {
    return this.database.connection === connection;
  }

  execute(command: RunCommand): RunAggregate {
    const connection = this.database.connection;
    const ownsTransaction = !connection.isTransaction;
    if (ownsTransaction) connection.exec("BEGIN IMMEDIATE");
    try {
      const aggregate =
        command.type === "run.create"
          ? this.create(command)
          : this.mutate(command);
      if (ownsTransaction) connection.exec("COMMIT");
      return aggregate;
    } catch (error) {
      if (ownsTransaction && connection.isTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  get(runId: string): RunAggregate | null {
    const row = this.database.connection
      .prepare("SELECT * FROM run_aggregates WHERE id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? mapAggregate(row) : null;
  }

  list(options?: {
    status?: RunAggregateStatus;
    sessionId?: string;
    limit?: number;
  }): RunAggregate[] {
    const limit = options?.limit ?? 50;
    if (options?.status && options.sessionId) {
      return (
        this.database.connection
          .prepare(
            `SELECT * FROM run_aggregates
             WHERE status = ? AND session_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(options.status, options.sessionId, limit) as Record<string, unknown>[]
      ).map(mapAggregate);
    }
    if (options?.status) {
      return (
        this.database.connection
          .prepare(
            `SELECT * FROM run_aggregates
             WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(options.status, limit) as Record<string, unknown>[]
      ).map(mapAggregate);
    }
    if (options?.sessionId) {
      return (
        this.database.connection
          .prepare(
            `SELECT * FROM run_aggregates
             WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(options.sessionId, limit) as Record<string, unknown>[]
      ).map(mapAggregate);
    }
    return (
      this.database.connection
        .prepare("SELECT * FROM run_aggregates ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[]
    ).map(mapAggregate);
  }

  listCheckpoints(runId: string): RunCheckpoint[] {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM run_checkpoints
         WHERE run_id = ? ORDER BY aggregate_version`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      aggregateVersion: Number(row.aggregate_version),
      stage: String(row.stage) as RunCheckpointStage,
      snapshot: parseJson(String(row.snapshot_json)),
      createdAt: String(row.created_at),
    }));
  }

  listToolLedger(runId: string): ToolLedgerEntry[] {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM tool_ledger
         WHERE run_id = ? ORDER BY aggregate_version, created_at`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapToolLedgerEntry);
  }

  getToolLedgerEntry(idempotencyKey: string): ToolLedgerEntry | null {
    const row = this.database.connection
      .prepare("SELECT * FROM tool_ledger WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapToolLedgerEntry(row) : null;
  }

  replayEvents(options: {
    afterCursor: number;
    limit: number;
  }): RuntimeDomainEventEnvelope[] {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM domain_event_outbox
         WHERE cursor > ? ORDER BY cursor LIMIT ?`,
      )
      .all(options.afterCursor, options.limit) as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  acknowledgeConsumer(consumerId: string, cursor: number): void {
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

  getConsumerCursor(consumerId: string): number {
    const row = this.database.connection
      .prepare("SELECT cursor FROM event_consumers WHERE consumer_id = ?")
      .get(consumerId) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  private create(command: Extract<RunCommand, { type: "run.create" }>): RunAggregate {
    const runId = command.runId ?? randomUUID();
    if (this.get(runId)) {
      throw new ConcurrentRunModificationError(runId, 0, 1);
    }
    const now = new Date().toISOString();
    const state: RunAggregateState = {
      round: 0,
      plan: null,
      childRunIds: [],
      inFlightEffects: [],
      verificationEvidence: [],
    };
    this.database.connection
      .prepare(
        `INSERT INTO run_aggregates (
          id, kind, status, aggregate_version, session_id, task_id,
          parent_run_id, trigger_id, goal, round, checkpoint_stage,
          recovery_status, state_json, correlation_id, causation_id,
          created_at, updated_at
        ) VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, 0, 'created',
          'none', ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        command.kind,
        command.sessionId ?? null,
        command.taskId ?? null,
        command.parentRunId ?? null,
        command.triggerId ?? null,
        command.goal ?? null,
        JSON.stringify(state),
        command.correlationId ?? runId,
        command.causationId ?? null,
        now,
        now,
      );
    const aggregate = this.require(runId);
    this.writeCheckpointAndEvent(aggregate, "run.created", now);
    return aggregate;
  }

  private mutate(
    command: Exclude<RunCommand, { type: "run.create" }>,
  ): RunAggregate {
    const existing = this.require(command.runId);
    if (existing.aggregateVersion !== command.expectedAggregateVersion) {
      throw new ConcurrentRunModificationError(
        existing.id,
        command.expectedAggregateVersion,
        existing.aggregateVersion,
      );
    }

    const mutation = mutationFor(command, existing);
    if (!ALLOWED_TRANSITIONS[existing.status].has(mutation.status)) {
      throw new IllegalRunTransitionError(existing.id, existing.status, mutation.status);
    }

    const nextVersion = existing.aggregateVersion + 1;
    const now = new Date().toISOString();
    const update = this.database.connection
      .prepare(
        `UPDATE run_aggregates SET
          status = ?,
          aggregate_version = ?,
          checkpoint_stage = ?,
          recovery_status = ?,
          wait_reason_json = ?,
          error = ?,
          result_json = ?,
          state_json = ?,
          causation_id = ?,
          updated_at = ?
         WHERE id = ? AND aggregate_version = ?`,
      )
      .run(
        mutation.status,
        nextVersion,
        mutation.checkpointStage,
        mutation.recoveryStatus,
        mutation.waitReason ? JSON.stringify(mutation.waitReason) : null,
        mutation.error ?? null,
        mutation.result === undefined ? null : JSON.stringify(mutation.result),
        JSON.stringify(mutation.state ?? existing.state),
        command.causationId ?? existing.causationId ?? null,
        now,
        existing.id,
        existing.aggregateVersion,
      );
    if (Number(update.changes) !== 1) {
      const actual = this.require(existing.id).aggregateVersion;
      throw new ConcurrentRunModificationError(
        existing.id,
        command.expectedAggregateVersion,
        actual,
      );
    }

    const aggregate = this.require(existing.id);
    this.writeToolLedger(command, aggregate, now);
    this.writeCheckpointAndEvent(aggregate, mutation.eventKind, now);
    return aggregate;
  }

  private writeToolLedger(
    command: Exclude<RunCommand, { type: "run.create" }>,
    aggregate: RunAggregate,
    now: string,
  ): void {
    if (command.type === "run.tool_intent") {
      const existing = this.getToolLedgerEntry(command.idempotencyKey);
      if (existing) {
        throw new Error(`tool_idempotency_conflict:${command.idempotencyKey}`);
      }
      this.database.connection.prepare(
        `INSERT INTO tool_ledger (
          idempotency_key, run_id, tool_name, tool_version, status,
          aggregate_version, input_hash, effects_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'intended', ?, ?, ?, ?, ?)`,
      ).run(
        command.idempotencyKey,
        aggregate.id,
        command.toolName,
        command.toolVersion,
        aggregate.aggregateVersion,
        command.inputHash,
        JSON.stringify(command.effects),
        now,
        now,
      );
      return;
    }
    if (command.type === "run.tool_start") {
      const update = this.database.connection.prepare(
        `UPDATE tool_ledger
         SET status='started', aggregate_version=?, started_at=?, updated_at=?
         WHERE idempotency_key=? AND run_id=? AND status='intended'`,
      ).run(
        aggregate.aggregateVersion,
        now,
        now,
        command.idempotencyKey,
        aggregate.id,
      );
      if (Number(update.changes) !== 1) {
        throw new Error(`tool_ledger_transition_invalid:${command.idempotencyKey}:started`);
      }
      return;
    }
    if (command.type === "run.tool_result") {
      const update = this.database.connection.prepare(
        `UPDATE tool_ledger SET
          status=?, aggregate_version=?, output_json=?, verification_json=?,
          finished_at=?, updated_at=?
         WHERE idempotency_key=? AND run_id=? AND status='started'`,
      ).run(
        command.status,
        aggregate.aggregateVersion,
        command.output === undefined ? null : JSON.stringify(command.output),
        command.verification === undefined ? null : JSON.stringify(command.verification),
        now,
        now,
        command.idempotencyKey,
        aggregate.id,
      );
      if (Number(update.changes) !== 1) {
        throw new Error(
          `tool_ledger_transition_invalid:${command.idempotencyKey}:${command.status}`,
        );
      }
      return;
    }
    if (command.type === "run.require_recovery" && !command.recoverable) {
      this.database.connection.prepare(
        `UPDATE tool_ledger
         SET status='recovery_required', aggregate_version=?, updated_at=?
         WHERE run_id=? AND status='started'`,
      ).run(aggregate.aggregateVersion, now, aggregate.id);
    }
  }

  private require(runId: string): RunAggregate {
    const aggregate = this.get(runId);
    if (!aggregate) throw new RunNotFoundError(runId);
    return aggregate;
  }

  private writeCheckpointAndEvent(
    aggregate: RunAggregate,
    eventKind: string,
    occurredAt: string,
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO run_checkpoints (
          id, run_id, aggregate_version, stage, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        aggregate.id,
        aggregate.aggregateVersion,
        aggregate.checkpointStage,
        JSON.stringify(aggregate),
        occurredAt,
      );

    this.database.connection
      .prepare(
        `INSERT INTO domain_event_outbox (
          event_id, schema_version, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, causation_id, event_type,
          event_json, occurred_at
        ) VALUES (?, '2.0', 'run', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        aggregate.id,
        aggregate.aggregateVersion,
        aggregate.correlationId ?? null,
        aggregate.causationId ?? null,
        eventKind,
        JSON.stringify({ kind: eventKind, run: aggregate }),
        occurredAt,
      );
  }
}

function mutationFor(
  command: Exclude<RunCommand, { type: "run.create" }>,
  existing: RunAggregate,
): RunMutation {
  switch (command.type) {
    case "run.start":
      return {
        status: "running",
        checkpointStage: "running",
        recoveryStatus: "none",
        eventKind: "run.started",
      };
    case "run.block":
      return waitingMutation("blocked", "blocked", command.reason, "run.blocked");
    case "run.request_confirmation":
      return waitingMutation(
        "waiting_confirmation",
        "waiting_confirmation",
        command.reason,
        "run.confirmation_requested",
      );
    case "run.request_plan_handoff":
      return waitingMutation(
        "waiting_plan_handoff",
        "waiting_plan_handoff",
        command.reason,
        "run.plan_handoff_requested",
      );
    case "run.pause":
      return waitingMutation("paused", "paused", command.reason, "run.paused", "recoverable");
    case "run.require_recovery":
      return waitingMutation(
        "recovery_required",
        "recovery_required",
        command.reason,
        "run.recovery_required",
        command.recoverable ? "recoverable" : "decision_required",
      );
    case "run.tool_intent":
      return {
        status: "running",
        checkpointStage: "tool_intended",
        recoveryStatus: "none",
        state: {
          ...existing.state,
          inFlightEffects: [
            ...existing.state.inFlightEffects,
            {
              idempotencyKey: command.idempotencyKey,
              toolName: command.toolName,
              status: "intended",
              resumable: command.resumable,
            },
          ],
        },
        eventKind: "run.tool_intended",
      };
    case "run.tool_start":
      return {
        status: "running",
        checkpointStage: "tool_started",
        recoveryStatus: "none",
        state: {
          ...existing.state,
          inFlightEffects: existing.state.inFlightEffects.map((effect) =>
            effect.idempotencyKey === command.idempotencyKey
              ? { ...effect, status: "started" }
              : effect,
          ),
        },
        eventKind: "run.tool_started",
      };
    case "run.tool_result":
      return {
        status: "running",
        checkpointStage:
          command.status === "succeeded"
            ? "tool_succeeded"
            : command.status === "failed"
              ? "tool_failed"
              : "tool_cancelled",
        recoveryStatus: "none",
        state: {
          ...existing.state,
          inFlightEffects: existing.state.inFlightEffects.filter(
            (effect) => effect.idempotencyKey !== command.idempotencyKey,
          ),
        },
        eventKind: `run.tool_${command.status}`,
      };
    case "run.complete":
      return {
        status: "completed",
        checkpointStage: "completed",
        recoveryStatus: "none",
        result: command.result,
        eventKind: "run.completed",
      };
    case "run.fail":
      return {
        status: "failed",
        checkpointStage: "failed",
        recoveryStatus: "none",
        error: command.error,
        eventKind: "run.failed",
      };
    case "run.cancel":
      return {
        status: "cancelled",
        checkpointStage: "cancelled",
        recoveryStatus: "none",
        error: command.reason,
        eventKind: "run.cancelled",
      };
  }
}

function waitingMutation(
  status: RunAggregateStatus,
  checkpointStage: RunCheckpointStage,
  waitReason: RunWaitReason,
  eventKind: string,
  recoveryStatus: RunRecoveryStatus = "none",
): RunMutation {
  return {
    status,
    checkpointStage,
    recoveryStatus,
    waitReason,
    eventKind,
  };
}

function mapAggregate(row: Record<string, unknown>): RunAggregate {
  return {
    id: String(row.id),
    kind: String(row.kind) as RunAggregate["kind"],
    status: String(row.status) as RunAggregateStatus,
    aggregateVersion: Number(row.aggregate_version),
    sessionId: optionalString(row.session_id),
    taskId: optionalString(row.task_id),
    parentRunId: optionalString(row.parent_run_id),
    triggerId: optionalString(row.trigger_id),
    goal: optionalString(row.goal),
    checkpointStage: String(row.checkpoint_stage) as RunCheckpointStage,
    recoveryStatus: String(row.recovery_status) as RunRecoveryStatus,
    waitReason: row.wait_reason_json
      ? (parseJson(String(row.wait_reason_json)) as RunWaitReason)
      : undefined,
    state: parseJson(String(row.state_json)) as RunAggregateState,
    error: optionalString(row.error),
    result: row.result_json ? parseJson(String(row.result_json)) : undefined,
    correlationId: optionalString(row.correlation_id),
    causationId: optionalString(row.causation_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): RuntimeDomainEventEnvelope {
  return {
    eventId: String(row.event_id),
    cursor: Number(row.cursor),
    schemaVersion: "2.0",
    aggregateType: "run",
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    correlationId: optionalString(row.correlation_id),
    causationId: optionalString(row.causation_id),
    occurredAt: String(row.occurred_at),
    event: parseJson(String(row.event_json)) as RuntimeDomainEventEnvelope["event"],
  };
}

function mapToolLedgerEntry(row: Record<string, unknown>): ToolLedgerEntry {
  return {
    idempotencyKey: String(row.idempotency_key),
    runId: String(row.run_id),
    toolName: String(row.tool_name),
    toolVersion: String(row.tool_version),
    status: String(row.status) as ToolLedgerEntry["status"],
    aggregateVersion: Number(row.aggregate_version),
    inputHash: String(row.input_hash),
    output: row.output_json ? parseJson(String(row.output_json)) : undefined,
    verification: row.verification_json
      ? parseJson(String(row.verification_json))
      : undefined,
    effects: parseJson(String(row.effects_json)) as string[],
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export type {
  RunAggregate,
  RunAggregateStatus,
  RunCheckpoint,
  RunCommand,
  RuntimeDomainEventEnvelope,
  ToolLedgerEntry,
} from "./runAggregateTypes.js";
