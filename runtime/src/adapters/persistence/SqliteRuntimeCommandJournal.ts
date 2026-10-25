import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAuthorityHealth, markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import { WORKSPACE_DOCUMENT_FAILURE_MESSAGES } from '@ariadne/protocol/public';

import { runtimeResponseSchema, type RuntimeResponse } from '@ariadne/protocol/host';

import type {
  RuntimeCommandBeginResultV2 as RuntimeCommandBeginResult,
  RuntimeCommandJournalV2 as RuntimeCommandJournal,
  RuntimeCommandReconciliationV2 as RuntimeCommandReconciliation
} from '../../control/ports/RuntimeCommandJournalV2.js';
import type { RuntimeCommandJournalStatus } from '../../control/ports/RuntimeCommandJournal.js';
type RuntimeCommandOutcome = RuntimeResponse['outcome'];
import {
  migrateRuntimeCommandDatabase,
  RUNTIME_COMMAND_DB_SCHEMA_VERSION,
  resolveRuntimeCommandDatabasePath
} from './runtimeCommandDbMigrations.js';
import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

interface RuntimeCommandRow {
  command_id: string;
  command_digest: string;
  status: RuntimeCommandJournalStatus;
  outcome_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface SqliteRuntimeCommandJournalOptions {
  retentionMs?: number;
  maxReplayOutcomes?: number;
  maxOutcomeBytes?: number;
  now?: () => number;
}

export const RUNTIME_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const RUNTIME_COMMAND_MAX_REPLAY_OUTCOMES = 1_024;
export const RUNTIME_COMMAND_MAX_OUTCOME_BYTES = 1_048_576;

const OUTCOME_SCHEMA = runtimeResponseSchema.shape.outcome;
/**
 * A dedicated file-backed connection for the Runtime ingress journal.
 * It exclusively owns data/runtime-control/runtime-command.db and never opens
 * the conversation or Agent control stores.
 *
 * Command identity tombstones are permanent and keyed by a one-way SHA-256
 * digest of the caller-provided command id. Only completed, allowlisted replay
 * payloads are retained within the configured age/count/size window;
 * non-replayable and uncertain outcomes are represented by a NULL payload.
 */
export class SqliteRuntimeCommandJournal implements RuntimeCommandJournal {
  public readonly schemaVersion = RUNTIME_COMMAND_DB_SCHEMA_VERSION;
  private database: DatabaseSync | null = null;
  private ownerLease: SqliteOwnerLease | null = null;
  private lifecycle: 'new' | 'open' | 'closed' = 'new';
  private health = new SqliteAuthorityHealth('journal');
  public assertHealthy(): void { this.health.assertHealthy(); if (this.lifecycle !== 'open') throw new Error('runtime_command_journal_not_open'); }

  private readonly retentionMs: number;
  private readonly maxReplayOutcomes: number;
  private readonly maxOutcomeBytes: number;
  private readonly now: () => number;

  constructor(options: SqliteRuntimeCommandJournalOptions = {}) {
    this.retentionMs = options.retentionMs ?? RUNTIME_COMMAND_RETENTION_MS;
    this.maxReplayOutcomes = options.maxReplayOutcomes ?? RUNTIME_COMMAND_MAX_REPLAY_OUTCOMES;
    this.maxOutcomeBytes = options.maxOutcomeBytes ?? RUNTIME_COMMAND_MAX_OUTCOME_BYTES;
    this.now = options.now ?? Date.now;
    assertPositiveInteger(this.retentionMs, 'retention_ms');
    assertPositiveInteger(this.maxReplayOutcomes, 'max_replay_outcomes');
    assertPositiveInteger(this.maxOutcomeBytes, 'max_outcome_bytes');
  }

  open(dataRoot: string): void {
    if (this.lifecycle !== 'new') throw new Error('runtime_command_journal_already_opened');
    const databasePath = resolveRuntimeCommandDatabasePath(dataRoot);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const ownerLease = acquireSqliteOwnerLease(databasePath, 'runtime-command-journal');
    const openingHealth = new SqliteAuthorityHealth('journal');
    let database: DatabaseSync | null = null;
    try {
      const openedDatabase = new DatabaseSync(databasePath);
      database = openedDatabase;
      openedDatabase.exec('PRAGMA foreign_keys = ON;');
      // This file has exactly one writer. Waiting here would hide a leaked
      // process/second owner and block request deadlines on the Node thread.
      openedDatabase.exec('PRAGMA busy_timeout = 0;');
      migrateRuntimeCommandDatabase(openedDatabase);
      openedDatabase.exec('PRAGMA journal_mode = WAL;');
      openedDatabase.exec('PRAGMA synchronous = FULL;');
      assertRuntimeCommandDatabasePragmas(openedDatabase);
      this.observe(() => inImmediateTransaction(openedDatabase, () => {
        for (const row of openedDatabase.prepare('SELECT * FROM runtime_commands ORDER BY command_id').iterate())
          validateCommandRow(row as unknown as RuntimeCommandRow);
      }, error => openingHealth.observeFailedRollback(error)), openingHealth);
      const now = this.nowIso();
      this.transaction(openedDatabase, () => {
        for (const row of openedDatabase.prepare("SELECT * FROM runtime_commands WHERE status='executing'").iterate())
          validateCommandRow(row as unknown as RuntimeCommandRow);
        openedDatabase.prepare("UPDATE runtime_commands SET status='uncertain',outcome_json=NULL,updated_at=? WHERE status='executing'").run(now);
        pruneReplayPayloads(
          openedDatabase,
          now,
          this.retentionMs,
          this.maxReplayOutcomes
        );
      }, openingHealth);
    } catch (error) {
      openingHealth.observe(error);
      if (database !== null) {
        try {
          closeOwnedSqliteDatabase(database, ownerLease);
        } catch (closeError) {
          throw new AggregateError([error, closeError], 'runtime_command_journal_open_cleanup_failed');
        }
      } else {
        ownerLease.close();
      }
      throw error;
    }
    this.database = database;
    this.ownerLease = ownerLease;
    this.health = openingHealth;
    this.lifecycle = 'open';
  }

  begin(commandId: string, commandDigest: string, previousDigests: readonly string[] = []): RuntimeCommandBeginResult {
    assertCommandIdentity(commandId, commandDigest);
    if (previousDigests.length > 8 || previousDigests.some(value => !/^[a-f0-9]{64}$/u.test(value))) throw new Error('runtime_command_previous_digest_invalid');
    const storageKey = commandStorageKey(commandId);
    const database = this.requireDatabase();
    return this.transaction(database, () => {
      const now = this.nowIso();
      pruneReplayPayloads(database, now, this.retentionMs, this.maxReplayOutcomes);
      const existing = selectCommand(database, storageKey);
      if (!existing) {
        database.prepare(
          `INSERT INTO runtime_commands (
             command_id, command_digest, status, outcome_json, created_at, updated_at
           ) VALUES (?, ?, 'executing', NULL, ?, ?)`
        ).run(storageKey, commandDigest, now, now);
        return { kind: 'started' };
      }
      if (existing.command_digest !== commandDigest) {
        if (!previousDigests.includes(existing.command_digest)) return { kind: 'conflict' };
        database.prepare('UPDATE runtime_commands SET command_digest=?,updated_at=? WHERE command_id=? AND command_digest=?')
          .run(commandDigest, now, storageKey, existing.command_digest);
      }
      if (existing.status === 'completed') {
        if (existing.outcome_json === null) {
          throw storageCorruption(`completed_outcome_missing:${storageKey}`);
        }
        return { kind: 'replay', outcome: parseOutcome(existing.outcome_json, storageKey) };
      }
      return { kind: 'uncertain' };
    });
  }

  getStatus(commandId: string): RuntimeCommandJournalStatus | null {
    if (commandId.length === 0) throw new Error('runtime_command_id_required');
    assertCommandId(commandId);
    return this.observe(() => selectCommand(this.requireDatabase(), commandStorageKey(commandId))?.status ?? null);
  }

  complete(
    commandId: string,
    commandDigest: string,
    outcome: unknown
  ): void {
    this.settle(commandId, commandDigest, 'completed', outcome);
  }

  markUncertain(
    commandId: string,
    commandDigest: string,
    outcome: unknown
  ): void {
    this.settle(commandId, commandDigest, 'uncertain', outcome);
  }

  public reconcileUncertain(
    commandId: string,
    commandDigest: string,
    reconciliation: RuntimeCommandReconciliation
  ): RuntimeCommandBeginResult {
    assertCommandIdentity(commandId, commandDigest);
    const storageKey = commandStorageKey(commandId);
    const database = this.requireDatabase();
    return this.transaction(database, () => {
      const existing = selectCommand(database, storageKey);
      if (!existing) throw storageCorruption(`command_missing:${storageKey}`);
      if (existing.command_digest !== commandDigest) return { kind: 'conflict' };
      if (existing.status === 'completed') {
        if (existing.outcome_json === null) {
          throw storageCorruption(`completed_outcome_missing:${storageKey}`);
        }
        return {
          kind: 'replay',
          outcome: parseOutcome(existing.outcome_json, storageKey)
        };
      }
      if (existing.status === 'executing') return { kind: 'uncertain' };

      const now = this.nowIso();
      if (reconciliation.kind === 'not_committed') {
        const reopened = database.prepare(
          `UPDATE runtime_commands
           SET status='executing', outcome_json=NULL, updated_at=?
           WHERE command_id=? AND command_digest=? AND status='uncertain'`
        ).run(now, storageKey, commandDigest);
        if (Number(reopened.changes) !== 1) {
          throw storageCorruption(`reconciliation_reopen_lost:${storageKey}`);
        }
        return { kind: 'started' };
      }

      const prepared = this.prepareSettlement('completed', reconciliation.outcome);
      if (prepared.status !== 'completed' || prepared.serialized === null) {
        // The domain has reconstructed an authorized receipt for this attempt.
        // Retention policy controls storage, not delivery: keep the tombstone so
        // every future attempt must obtain fresh evidence from that same owner.
        return { kind: 'replay', outcome: OUTCOME_SCHEMA.parse(reconciliation.outcome) };
      }
      const completed = database.prepare(
        `UPDATE runtime_commands
         SET status='completed', outcome_json=?, updated_at=?
         WHERE command_id=? AND command_digest=? AND status='uncertain'`
      ).run(prepared.serialized, now, storageKey, commandDigest);
      if (Number(completed.changes) !== 1) {
        throw storageCorruption(`reconciliation_complete_lost:${storageKey}`);
      }
      return {
        kind: 'replay',
        outcome: parseOutcome(prepared.serialized, storageKey)
      };
    });
  }

  close(): void {
    if (this.lifecycle === 'closed') return;
    if (this.lifecycle === 'new') {
      this.lifecycle = 'closed';
      return;
    }
    const database = this.database;
    const ownerLease = this.ownerLease;
    if (database !== null && ownerLease !== null) {
      closeOwnedSqliteDatabase(database, ownerLease);
    } else {
      database?.close();
      ownerLease?.close();
    }
    this.database = null;
    this.ownerLease = null;
    this.lifecycle = 'closed';
  }

  private settle(
    commandId: string,
    commandDigest: string,
    status: Extract<RuntimeCommandJournalStatus, 'completed' | 'uncertain'>,
    outcome: unknown
  ): void {
    assertCommandIdentity(commandId, commandDigest);
    const storageKey = commandStorageKey(commandId);
    const prepared = this.prepareSettlement(status, outcome);
    const database = this.requireDatabase();
    this.transaction(database, () => {
      const now = this.nowIso();
      pruneReplayPayloads(database, now, this.retentionMs, this.maxReplayOutcomes);
      const existing = selectCommand(database, storageKey);
      if (!existing) throw storageCorruption(`command_missing:${storageKey}`);
      if (existing.command_digest !== commandDigest) {
        throw new Error('runtime_command_journal_digest_conflict');
      }
      if (existing.status === 'completed') {
        if (prepared.status === 'completed' && existing.outcome_json === prepared.serialized) {
          return;
        }
        throw new Error('runtime_command_journal_already_completed');
      }
      if (existing.status === 'uncertain') {
        return;
      }
      const updated = database.prepare(
        `UPDATE runtime_commands
         SET status=?, outcome_json=?, updated_at=?
         WHERE command_id=? AND command_digest=? AND status='executing'`
      ).run(
        prepared.status,
        prepared.serialized,
        now,
        storageKey,
        commandDigest
      );
      if (Number(updated.changes) !== 1) {
        throw storageCorruption(`settlement_lost:${storageKey}`);
      }
      pruneReplayPayloads(database, now, this.retentionMs, this.maxReplayOutcomes);
    });
  }

  private prepareSettlement(
    status: Extract<RuntimeCommandJournalStatus, 'completed' | 'uncertain'>,
    outcome: unknown
  ): {
    status: Extract<RuntimeCommandJournalStatus, 'completed' | 'uncertain'>;
    serialized: string | null;
  } {
    const parsedOutcome = OUTCOME_SCHEMA.parse(outcome);
    const serialized = JSON.stringify(parsedOutcome);
    if (
      status === 'completed'
      && isReplaySafeOutcome(parsedOutcome)
      && Buffer.byteLength(serialized, 'utf8') <= this.maxOutcomeBytes
      && !containsSensitiveAuthorization(serialized)
    ) {
      return { status, serialized };
    }
    return { status: 'uncertain', serialized: null };
  }

  private nowIso(): string {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('runtime_command_journal_clock_invalid');
    return new Date(now).toISOString();
  }

  private requireDatabase(): DatabaseSync {
    this.health.assertHealthy();
    if (this.lifecycle !== 'open' || !this.database) {
      throw new Error('runtime_command_journal_not_open');
    }
    return this.database;
  }
  private observe<T>(operation: () => T, health = this.health): T {
    health.assertHealthy();
    try { return operation(); } catch (error) { health.observe(error); throw error; }
  }
  private transaction<T>(database: DatabaseSync, operation: () => T, health = this.health): T {
    return this.observe(() => inImmediateTransaction(database, operation, error => health.observeFailedRollback(error)), health);
  }
}

function assertRuntimeCommandDatabasePragmas(database: DatabaseSync): void {
  const foreignKeys = database.prepare('PRAGMA foreign_keys;').get() as {
    foreign_keys: number;
  };
  const busyTimeout = database.prepare('PRAGMA busy_timeout;').get() as {
    timeout: number;
  };
  const journalMode = database.prepare('PRAGMA journal_mode;').get() as {
    journal_mode: string;
  };
  const synchronous = database.prepare('PRAGMA synchronous;').get() as {
    synchronous: number;
  };
  if (
    Number(foreignKeys.foreign_keys) !== 1
    || Number(busyTimeout.timeout) !== 0
    || journalMode.journal_mode.toLowerCase() !== 'wal'
    || Number(synchronous.synchronous) !== 2
  ) {
    throw new Error('runtime_command_db_pragma_verification_failed');
  }
}

function pruneReplayPayloads(
  database: DatabaseSync,
  now: string,
  retentionMs: number,
  maxReplayOutcomes: number
): void {
  const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();
  for (const row of database.prepare("SELECT * FROM runtime_commands WHERE status='completed' AND outcome_json IS NOT NULL AND updated_at<?").iterate(cutoff))
    validateCommandRow(row as unknown as RuntimeCommandRow);
  database.prepare(
    `UPDATE runtime_commands
     SET status='uncertain', outcome_json=NULL
     WHERE status='completed' AND outcome_json IS NOT NULL AND updated_at < ?`
  ).run(cutoff);
  for (const row of database.prepare(`SELECT * FROM runtime_commands WHERE status='completed' AND outcome_json IS NOT NULL
    ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ?`).iterate(maxReplayOutcomes))
    validateCommandRow(row as unknown as RuntimeCommandRow);
  database.prepare(
    `UPDATE runtime_commands
     SET status='uncertain', outcome_json=NULL
     WHERE rowid IN (
       SELECT rowid
       FROM runtime_commands
       WHERE status='completed' AND outcome_json IS NOT NULL
       ORDER BY updated_at DESC, rowid DESC
       LIMIT -1 OFFSET ?
     )`
  ).run(maxReplayOutcomes);
}

function isReplaySafeOutcome(outcome: RuntimeCommandOutcome): boolean {
  if (!outcome.ok) return Object.hasOwn(WORKSPACE_DOCUMENT_FAILURE_MESSAGES,outcome.error.code)
    && outcome.error.message===WORKSPACE_DOCUMENT_FAILURE_MESSAGES[outcome.error.code];
  if (outcome.result.kind === 'acknowledged') return true;
  if (['workspace.document.saved','workspace.document.moved','workspace.document.deleted'].includes(outcome.result.kind))return true;
  return outcome.result.kind === 'runtime.status'
    && outcome.result.status.detail === undefined;
}

function containsSensitiveAuthorization(serialized: string): boolean {
  return [
    /\b(?:bearer|basic)\s+[a-z0-9._~+\/-]{8,}={0,2}/iu,
    /"(?:apiKey|accessToken|refreshToken|clientSecret|authorization)"\s*:\s*"[^"\\]{8,}"/iu,
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[a-z0-9]{20,}\b/iu,
    /\bsk-[a-z0-9_-]{20,}\b/iu
  ].some((pattern) => pattern.test(serialized));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`runtime_command_journal_${name}_invalid`);
  }
}

function selectCommand(database: DatabaseSync, storageKey: string): RuntimeCommandRow | null {
  const row = database.prepare(
    `SELECT command_id, command_digest, status, outcome_json, created_at, updated_at
     FROM runtime_commands
     WHERE command_id=?`
  ).get(storageKey) as RuntimeCommandRow | undefined;
  if (!row) return null;
  validateCommandRow(row);
  return row;
}

function parseOutcome(serialized: string, storageKey: string): RuntimeCommandOutcome {
  try {
    return OUTCOME_SCHEMA.parse(JSON.parse(serialized));
  } catch (error) {
    throw storageCorruption(`outcome_invalid:${storageKey}`, error);
  }
}

function assertCommandIdentity(commandId: string, commandDigest: string): void {
  assertCommandId(commandId);
  if (!/^[a-f0-9]{64}$/u.test(commandDigest)) {
    throw new Error('runtime_command_digest_invalid');
  }
}

function assertCommandId(commandId: string): void {
  if (
    commandId.length === 0
    || commandId.length > 256
    || commandId.trim() !== commandId
  ) {
    throw new Error('runtime_command_id_invalid');
  }
}

function commandStorageKey(commandId: string): string {
  return createHash('sha256').update(commandId, 'utf8').digest('hex');
}

function inImmediateTransaction<T>(database: DatabaseSync, operation: () => T, rollbackFailed?: (error: unknown) => void): T {
  if (database.isTransaction) throw new Error('runtime_command_journal_transaction_active');
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) {
      try { database.exec('ROLLBACK'); }
      catch (rollbackError) { rollbackFailed?.(rollbackError); throw new AggregateError([error, rollbackError], 'runtime_command_journal_rollback_failed'); }
    }
    throw error;
  }
}

function storageCorruption(message: string, cause?: unknown): Error {
  return markAuthorityIntegrityError('journal', new Error(`runtime_command_journal_corruption:${message}`, { cause }));
}
function validateCommandRow(row: RuntimeCommandRow): void {
  if (typeof row.command_id !== 'string' || !/^[a-f0-9]{64}$/u.test(row.command_id)
    || typeof row.command_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.command_digest)) throw storageCorruption('identity_invalid');
  if (!['executing', 'completed', 'uncertain'].includes(row.status)) throw storageCorruption(`status_invalid:${row.command_id}`);
  for (const value of [row.created_at, row.updated_at]) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      throw storageCorruption('timestamp_invalid');
  }
  if (row.status === 'completed') {
    if (typeof row.outcome_json !== 'string') throw storageCorruption(`completed_outcome_missing:${row.command_id}`);
    const outcome = parseOutcome(row.outcome_json, row.command_id);
    if (!isReplaySafeOutcome(outcome) || containsSensitiveAuthorization(row.outcome_json)) throw storageCorruption('outcome_not_replay_safe');
  } else if (row.outcome_json !== null) throw storageCorruption('uncertain_payload_present');
}
