import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RuntimeResponse } from '@ariadne/protocol/host';
import { describe, expect, it } from 'vitest';

import {
  RUNTIME_COMMAND_MAX_REPLAY_OUTCOMES,
  RUNTIME_COMMAND_RETENTION_MS,
  SqliteRuntimeCommandJournal
} from '../src/adapters/persistence/SqliteRuntimeCommandJournal.js';
import {
  RUNTIME_COMMAND_DB_SCHEMA_VERSION,
  resolveRuntimeCommandDatabasePath
} from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import { DatabaseManager } from '../src/context/DatabaseManager.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const openJournals = new Set<SqliteRuntimeCommandJournal>();

interface PersistedCommandRow {
  command_id: string;
  command_digest: string;
  status: 'executing' | 'completed' | 'uncertain';
  outcome_json: string | null;
}

describe('SqliteRuntimeCommandJournal', () => {
  it('rejects non-canonical command identities before writing a tombstone', () => {
    const root = createDataRoot();
    try {
      const journal = createJournal();
      journal.open(root);
      expect(() => journal.begin(' command-with-space ', DIGEST_A))
        .toThrow('runtime_command_id_invalid');
      expect(() => journal.begin('c'.repeat(257), DIGEST_A))
        .toThrow('runtime_command_id_invalid');
      expect(readPersistedCommands(root)).toEqual([]);
      journal.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('owns a physically isolated database containing only its schema and migration audit', () => {
    const root = createDataRoot();
    try {
      const memory = new DatabaseManager(path.join(root, 'data'));
      memory.connection.exec(`
        CREATE TABLE owner_fencing_sentinel (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO owner_fencing_sentinel(id, value)
        VALUES ('memory-owner', 'must-not-change');
      `);
      memory.close();
      const memoryPath = path.join(root, 'data', 'agent_data', 'memory.db');
      const memoryBefore = readDatabaseSnapshot(memoryPath);

      const journal = createJournal();
      journal.open(root);
      expect(readJournalPragmas(journal)).toEqual({
        foreignKeys: 1,
        busyTimeout: 0,
        journalMode: 'wal',
        synchronous: 2
      });
      expect(journal.begin('physical-isolation-command', DIGEST_A))
        .toEqual({ kind: 'started' });
      journal.complete('physical-isolation-command', DIGEST_A, acknowledgedOutcome());
      journal.close();

      expect(databasePath(root)).toBe(
        path.resolve(root, 'data', 'runtime-control', 'runtime-command.db')
      );
      expect(existsSync(databasePath(root))).toBe(true);
      expect(readDatabaseSnapshot(memoryPath)).toEqual(memoryBefore);

      const database = new DatabaseSync(databasePath(root), { readOnly: true });
      try {
        expect(readUserVersion(database)).toBe(RUNTIME_COMMAND_DB_SCHEMA_VERSION);
        expect(readApplicationTables(database)).toEqual([
          'runtime_commands',
          'schema_migrations'
        ]);
        expect(readApplicationTables(database)).not.toEqual(
          expect.arrayContaining([
            'sessions',
            'messages',
            'agent_v3_runs',
            'agent_v3_events',
            'agent_v3_outbox'
          ])
        );
        expect(readMigrationAudit(database)).toEqual([
          expect.objectContaining({
            version: RUNTIME_COMMAND_DB_SCHEMA_VERSION,
            name: 'runtime_command_journal'
          })
        ]);
      } finally {
        database.close();
      }
    } finally {
      cleanupRoot(root);
    }
  });

  it('fails a second same-path journal before business DB access and reopens after close', () => {
    const root = createDataRoot();
    try {
      const first = createJournal();
      const second = createJournal();
      first.open(root);
      expect(() => second.open(root))
        .toThrow(/sqlite_owner_lease_unavailable:runtime-command-journal/);

      first.close();
      expect(() => second.open(root)).not.toThrow();
      second.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('reopens idempotently without duplicating or rewriting migration audit', () => {
    const root = createDataRoot();
    try {
      const first = createJournal();
      first.open(root);
      first.close();
      const firstAudit = readMigrationAuditFromRoot(root);

      const reopened = createJournal();
      reopened.open(root);
      reopened.close();

      expect(readMigrationAuditFromRoot(root)).toEqual(firstAudit);
      expect(firstAudit).toHaveLength(1);
    } finally {
      cleanupRoot(root);
    }
  });

  it('fails closed without mutating a database from a newer schema version', () => {
    const root = createDataRoot();
    mkdirSync(path.dirname(databasePath(root)), { recursive: true });
    const newer = new DatabaseSync(databasePath(root));
    newer.exec(`PRAGMA user_version = ${String(RUNTIME_COMMAND_DB_SCHEMA_VERSION + 1)}`);
    newer.close();

    try {
      const journal = createJournal();
      expect(() => journal.open(root)).toThrow(
        `runtime_command_db_schema_newer_than_runtime:`
        + `${String(RUNTIME_COMMAND_DB_SCHEMA_VERSION + 1)}:`
        + String(RUNTIME_COMMAND_DB_SCHEMA_VERSION)
      );

      const unchanged = new DatabaseSync(databasePath(root), { readOnly: true });
      try {
        expect(readUserVersion(unchanged)).toBe(RUNTIME_COMMAND_DB_SCHEMA_VERSION + 1);
        expect(readApplicationTables(unchanged)).toEqual([]);
      } finally {
        unchanged.close();
      }
    } finally {
      cleanupRoot(root);
    }
  });

  it('does not mutate an unversioned database containing a foreign view', () => {
    const root = createDataRoot();
    mkdirSync(path.dirname(databasePath(root)), { recursive: true });
    const foreign = new DatabaseSync(databasePath(root));
    foreign.exec('CREATE VIEW alien_view AS SELECT 1 AS value;');
    const before = readSchemaSnapshot(foreign);
    foreign.close();

    const journal = createJournal();
    expect(() => journal.open(root)).toThrow(
      /runtime_command_db_unmanaged_schema:view:alien_view/
    );

    const reopened = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      expect(readSchemaSnapshot(reopened)).toEqual(before);
    } finally {
      reopened.close();
    }

    const repaired = new DatabaseSync(databasePath(root));
    repaired.exec('DROP VIEW alien_view;');
    repaired.close();
    expect(() => journal.open(root)).not.toThrow();
    journal.close();
    cleanupRoot(root);
  });

  it('replays the complete outcome after the adapter and Runtime are reopened', () => {
    const root = createDataRoot();
    let first: SqliteRuntimeCommandJournal | undefined;
    let reopened: SqliteRuntimeCommandJournal | undefined;
    const outcome: RuntimeResponse['outcome'] = {
      ok: true,
      result: {
        kind: 'runtime.status',
        status: {
          availability: 'ready',
          runtimeVersion: '0.1.0',
          runtimeBuildFingerprint: 'f'.repeat(64),
          protocolVersion: '3.0',
          capabilities: ['companion.chat', 'agent.runs'],
          observedAt: '2026-07-31T10:00:00.000Z'
        }
      }
    };
    try {
      first = createJournal();
      first.open(root);
      expect(first.begin('command-replay', DIGEST_A)).toEqual({ kind: 'started' });
      first.complete('command-replay', DIGEST_A, outcome);
      first.close();

      reopened = createJournal();
      reopened.open(root);
      expect(reopened.begin('command-replay', DIGEST_A)).toEqual({
        kind: 'replay',
        outcome
      });
      reopened.close();
      reopened.close();
    } finally {
      first?.close();
      reopened?.close();
      cleanupRoot(root);
    }
  });

  it('rejects a commandId rebound to a different digest across reopen', () => {
    const root = createDataRoot();
    try {
      const first = createJournal();
      first.open(root);
      expect(first.begin('command-conflict', DIGEST_A)).toEqual({ kind: 'started' });
      first.complete('command-conflict', DIGEST_A, acknowledgedOutcome());
      first.close();

      const reopened = createJournal();
      reopened.open(root);
      expect(reopened.begin('command-conflict', DIGEST_B)).toEqual({ kind: 'conflict' });
      reopened.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('stores only SHA-256 command keys while the raw id still replays and conflicts after reopen', () => {
    const root = createDataRoot();
    const replayCommandId = 'Authorization: Bearer command-id-secret-123456789';
    const uncertainCommandId = 'clientSecret=command-id-private-987654321';
    try {
      const first = createJournal();
      first.open(root);
      expect(first.begin(replayCommandId, DIGEST_A)).toEqual({ kind: 'started' });
      first.complete(replayCommandId, DIGEST_A, acknowledgedOutcome());
      expect(first.begin(uncertainCommandId, DIGEST_B)).toEqual({ kind: 'started' });
      first.markUncertain(
        uncertainCommandId,
        DIGEST_B,
        uncertainOutcome(uncertainCommandId)
      );
      first.close();

      const rows = readPersistedCommands(root);
      const replayRow = rows.find((row) => row.command_digest === DIGEST_A);
      const uncertainRow = rows.find((row) => row.command_digest === DIGEST_B);
      expect(replayRow).toMatchObject({
        command_id: sha256(replayCommandId),
        status: 'completed'
      });
      expect(uncertainRow).toEqual({
        command_id: sha256(uncertainCommandId),
        command_digest: DIGEST_B,
        status: 'uncertain',
        outcome_json: null
      });
      expect(JSON.stringify(rows)).not.toContain(replayCommandId);
      expect(JSON.stringify(rows)).not.toContain(uncertainCommandId);
      const databaseBytes = readFileSync(databasePath(root));
      expect(databaseBytes.includes(Buffer.from(replayCommandId, 'utf8'))).toBe(false);
      expect(databaseBytes.includes(Buffer.from(uncertainCommandId, 'utf8'))).toBe(false);

      const reopened = createJournal();
      reopened.open(root);
      expect(reopened.begin(replayCommandId, DIGEST_A)).toEqual({
        kind: 'replay',
        outcome: acknowledgedOutcome()
      });
      expect(reopened.begin(replayCommandId, DIGEST_B)).toEqual({ kind: 'conflict' });
      expect(reopened.begin(uncertainCommandId, DIGEST_B)).toEqual({ kind: 'uncertain' });
      expect(reopened.begin(uncertainCommandId, DIGEST_A)).toEqual({ kind: 'conflict' });
      reopened.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('recovers commands left executing by a prior Runtime as uncertain', () => {
    const root = createDataRoot();
    try {
      const interrupted = createJournal();
      interrupted.open(root);
      expect(interrupted.begin('command-interrupted', DIGEST_A)).toEqual({ kind: 'started' });
      interrupted.close();

      const recovered = createJournal();
      recovered.open(root);
      expect(recovered.getStatus('command-interrupted')).toBe('uncertain');
      expect(recovered.begin('command-interrupted', DIGEST_A)).toEqual({ kind: 'uncertain' });
      recovered.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('reopens an uncertain command only after all domain owners prove no commit', () => {
    const root = createDataRoot();
    try {
      const interrupted = createJournal();
      interrupted.open(root);
      expect(interrupted.begin('command-safe-reopen', DIGEST_A))
        .toEqual({ kind: 'started' });
      interrupted.close();

      const recovered = createJournal();
      recovered.open(root);
      expect(recovered.reconcileUncertain(
        'command-safe-reopen',
        DIGEST_A,
        { kind: 'not_committed' }
      )).toEqual({ kind: 'started' });
      // A second caller cannot take over an execution that was already
      // explicitly reopened by the reconciler.
      expect(recovered.reconcileUncertain(
        'command-safe-reopen',
        DIGEST_A,
        { kind: 'not_committed' }
      )).toEqual({ kind: 'uncertain' });
      recovered.complete('command-safe-reopen', DIGEST_A, acknowledgedOutcome());
      expect(recovered.begin('command-safe-reopen', DIGEST_A)).toEqual({
        kind: 'replay',
        outcome: acknowledgedOutcome()
      });
      recovered.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('materializes a replay-safe acknowledgement from a durable domain receipt', () => {
    const root = createDataRoot();
    const accepted: RuntimeResponse['outcome'] = {
      ok: true,
      result: { kind: 'acknowledged' }
    };
    try {
      const journal = createJournal();
      journal.open(root);
      expect(journal.begin('command-committed-receipt', DIGEST_A))
        .toEqual({ kind: 'started' });
      journal.markUncertain(
        'command-committed-receipt',
        DIGEST_A,
        uncertainOutcome('command-committed-receipt')
      );
      expect(journal.reconcileUncertain(
        'command-committed-receipt',
        DIGEST_B,
        { kind: 'committed', outcome: accepted }
      )).toEqual({ kind: 'conflict' });
      expect(journal.reconcileUncertain(
        'command-committed-receipt',
        DIGEST_A,
        { kind: 'committed', outcome: accepted }
      )).toEqual({ kind: 'replay', outcome: accepted });
      expect(journal.reconcileUncertain(
        'command-committed-receipt',
        DIGEST_A,
        { kind: 'committed', outcome: accepted }
      )).toEqual({ kind: 'replay', outcome: accepted });
      expect(journal.begin('command-committed-receipt', DIGEST_A))
        .toEqual({ kind: 'replay', outcome: accepted });
      journal.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('keeps an uncertain tombstone when receipt reconstruction is not replay-safe', () => {
    const root = createDataRoot();
    const privateOutcome: RuntimeResponse['outcome'] = {
      ok: true,
      result: {
        kind: 'runtime.status',
        status: {
          availability: 'ready',
          capabilities: [],
          observedAt: '2026-07-31T10:00:00.000Z',
          detail: 'must not enter the Runtime command journal'
        }
      }
    };
    try {
      const journal = createJournal();
      journal.open(root);
      expect(journal.begin('command-private-reconcile', DIGEST_A))
        .toEqual({ kind: 'started' });
      journal.markUncertain(
        'command-private-reconcile',
        DIGEST_A,
        uncertainOutcome('command-private-reconcile')
      );
      expect(() => journal.reconcileUncertain(
        'command-private-reconcile',
        DIGEST_A,
        { kind: 'committed', outcome: privateOutcome }
      )).toThrow('runtime_command_reconciliation_outcome_not_replay_safe');
      expect(journal.getStatus('command-private-reconcile')).toBe('uncertain');
      expect(readPersistedOutcomes(root)).not.toContain(
        'must not enter the Runtime command journal'
      );
      journal.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('prunes replay payloads but permanently retains command identity tombstones', () => {
    const root = createDataRoot();
    const options = { maxReplayOutcomes: 1 };
    try {
      const first = createJournal(options);
      first.open(root);
      expect(first.begin('command-old', DIGEST_A)).toEqual({ kind: 'started' });
      first.complete('command-old', DIGEST_A, acknowledgedOutcome());
      expect(first.begin('command-new', DIGEST_B)).toEqual({ kind: 'started' });
      first.complete('command-new', DIGEST_B, acknowledgedOutcome());

      expect(first.getStatus('command-old')).toBe('uncertain');
      expect(first.begin('command-old', DIGEST_A)).toEqual({ kind: 'uncertain' });
      expect(first.begin('command-old', DIGEST_B)).toEqual({ kind: 'conflict' });
      first.close();

      const reopened = createJournal(options);
      reopened.open(root);
      expect(reopened.begin('command-old', DIGEST_A)).toEqual({ kind: 'uncertain' });
      expect(reopened.begin('command-old', DIGEST_B)).toEqual({ kind: 'conflict' });
      reopened.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('does not let 1025 uncertain tombstones consume the completed replay quota', () => {
    const root = createDataRoot();
    const replayCommandId = 'command-replay-anchor';
    try {
      const journal = createJournal();
      journal.open(root);
      expect(journal.begin(replayCommandId, DIGEST_A)).toEqual({ kind: 'started' });
      journal.complete(replayCommandId, DIGEST_A, acknowledgedOutcome());

      for (let index = 0; index <= RUNTIME_COMMAND_MAX_REPLAY_OUTCOMES; index += 1) {
        const commandId = `command-uncertain-${String(index)}`;
        expect(journal.begin(commandId, DIGEST_B)).toEqual({ kind: 'started' });
        journal.markUncertain(commandId, DIGEST_B, uncertainOutcome(commandId));
      }

      expect(journal.begin(replayCommandId, DIGEST_A)).toEqual({
        kind: 'replay',
        outcome: acknowledgedOutcome()
      });
      journal.close();

      const rows = readPersistedCommands(root);
      expect(rows.filter((row) => row.status === 'completed')).toHaveLength(1);
      expect(
        rows.filter((row) => row.status === 'uncertain' && row.outcome_json !== null)
      ).toHaveLength(0);
    } finally {
      cleanupRoot(root);
    }
  });

  it('turns expired replay payloads into uncertain tombstones instead of reusable ids', () => {
    const root = createDataRoot();
    let now = Date.parse('2026-07-31T10:00:00.000Z');
    const options = { now: () => now };
    try {
      const first = createJournal(options);
      first.open(root);
      expect(first.begin('command-expired', DIGEST_A)).toEqual({ kind: 'started' });
      first.complete('command-expired', DIGEST_A, acknowledgedOutcome());
      first.close();

      now += RUNTIME_COMMAND_RETENTION_MS + 1;
      const reopened = createJournal(options);
      reopened.open(root);
      expect(reopened.getStatus('command-expired')).toBe('uncertain');
      expect(reopened.begin('command-expired', DIGEST_A)).toEqual({ kind: 'uncertain' });
      expect(reopened.begin('command-expired', DIGEST_B)).toEqual({ kind: 'conflict' });
      reopened.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('never persists arbitrary message or error text outside the replay-safe allowlist', () => {
    const root = createDataRoot();
    const privateText = 'credential-material-Z9vQ2mL7pR4xT8nC6w';
    const rawAuthorization = 'Authorization: Bearer runtime-secret-token-123456789';
    const messageOutcome: RuntimeResponse['outcome'] = {
      ok: true,
      result: {
        kind: 'runtime.status',
        status: {
          availability: 'ready',
          capabilities: [],
          observedAt: '2026-07-31T10:00:00.000Z',
          detail: privateText
        }
      }
    };
    const errorOutcome: RuntimeResponse['outcome'] = {
      ok: false,
      error: {
        code: 'deterministic_failure',
        message: rawAuthorization,
        retryable: false,
        correlationId: 'command-private-error',
        details: [privateText]
      }
    };
    try {
      const journal = createJournal();
      journal.open(root);
      expect(journal.begin('command-private-message', DIGEST_A)).toEqual({ kind: 'started' });
      journal.complete('command-private-message', DIGEST_A, messageOutcome);
      expect(journal.begin('command-private-error', DIGEST_B)).toEqual({ kind: 'started' });
      journal.complete('command-private-error', DIGEST_B, errorOutcome);
      expect(journal.getStatus('command-private-message')).toBe('uncertain');
      expect(journal.getStatus('command-private-error')).toBe('uncertain');
      journal.close();

      const persisted = readPersistedOutcomes(root);
      expect(persisted).not.toContain(privateText);
      expect(persisted).not.toContain(rawAuthorization);
      expect(
        readPersistedCommands(root)
          .filter((row) => row.status === 'uncertain')
          .every((row) => row.outcome_json === null)
      ).toBe(true);

      const reopened = createJournal();
      reopened.open(root);
      expect(reopened.begin('command-private-message', DIGEST_A)).toEqual({ kind: 'uncertain' });
      expect(reopened.begin('command-private-error', DIGEST_B)).toEqual({ kind: 'uncertain' });
      reopened.close();
    } finally {
      cleanupRoot(root);
    }
  });

  it('does not retain an otherwise replay-safe outcome above the byte limit', () => {
    const root = createDataRoot();
    const outcome: RuntimeResponse['outcome'] = {
      ok: true,
      result: {
        kind: 'runtime.status',
        status: {
          availability: 'ready',
          capabilities: Array.from({ length: 100 }, () => 'companion.chat' as const),
          observedAt: '2026-07-31T10:00:00.000Z'
        }
      }
    };
    try {
      const journal = createJournal({ maxOutcomeBytes: 256 });
      journal.open(root);
      expect(journal.begin('command-large', DIGEST_A)).toEqual({ kind: 'started' });
      journal.complete('command-large', DIGEST_A, outcome);
      expect(journal.getStatus('command-large')).toBe('uncertain');
      journal.close();

      expect(readPersistedOutcomes(root)).not.toContain('companion.chat');
    } finally {
      cleanupRoot(root);
    }
  });

  it('uses the status-leading index for both completed replay pruning queries', () => {
    const root = createDataRoot();
    const journal = createJournal();
    journal.open(root);
    journal.close();
    const database = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      const agePlan = explainQueryPlan(
        database,
        `UPDATE runtime_commands
         SET status='uncertain', outcome_json=NULL
         WHERE status='completed' AND outcome_json IS NOT NULL AND updated_at < ?`,
        '2026-07-31T10:00:00.000Z'
      );
      const quotaPlan = explainQueryPlan(
        database,
        `UPDATE runtime_commands
         SET status='uncertain', outcome_json=NULL
         WHERE rowid IN (
           SELECT rowid
           FROM runtime_commands
           WHERE status='completed' AND outcome_json IS NOT NULL
           ORDER BY updated_at DESC, rowid DESC
           LIMIT -1 OFFSET ?
         )`,
        RUNTIME_COMMAND_MAX_REPLAY_OUTCOMES
      );

      expect(agePlan).toContain('idx_runtime_commands_status');
      expect(quotaPlan).toContain('idx_runtime_commands_status');
    } finally {
      database.close();
      cleanupRoot(root);
    }
  });
});

function createDataRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ariadne-runtime-command-journal-'));
}

function createJournal(
  options?: ConstructorParameters<typeof SqliteRuntimeCommandJournal>[0]
): SqliteRuntimeCommandJournal {
  const journal = new SqliteRuntimeCommandJournal(options);
  openJournals.add(journal);
  return journal;
}

function cleanupRoot(root: string): void {
  for (const journal of openJournals) journal.close();
  openJournals.clear();
  rmSync(root, { recursive: true, force: true });
}

function readSchemaSnapshot(database: DatabaseSync): {
  readonly userVersion: number;
  readonly objects: readonly Record<string, unknown>[];
} {
  return {
    userVersion: readUserVersion(database),
    objects: database.prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    ).all() as unknown as Record<string, unknown>[]
  };
}

function acknowledgedOutcome(): RuntimeResponse['outcome'] {
  return {
    ok: true,
    result: { kind: 'acknowledged' }
  };
}

function uncertainOutcome(commandId: string): RuntimeResponse['outcome'] {
  return {
    ok: false,
    error: {
      code: 'command_outcome_uncertain',
      message: `Outcome not retained for ${commandId}`,
      retryable: false,
      correlationId: commandId
    }
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function databasePath(root: string): string {
  return resolveRuntimeCommandDatabasePath(root);
}

function readJournalPragmas(journal: SqliteRuntimeCommandJournal): {
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly journalMode: string;
  readonly synchronous: number;
} {
  const database = (journal as unknown as { database: DatabaseSync }).database;
  return {
    foreignKeys: Number((database.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    }).foreign_keys),
    busyTimeout: Number((database.prepare('PRAGMA busy_timeout').get() as {
      timeout: number;
    }).timeout),
    journalMode: String((database.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    }).journal_mode).toLowerCase(),
    synchronous: Number((database.prepare('PRAGMA synchronous').get() as {
      synchronous: number;
    }).synchronous)
  };
}

function readDatabaseSnapshot(databaseFile: string): {
  readonly bytes: Buffer;
  readonly userVersion: number;
  readonly schema: readonly Record<string, unknown>[];
  readonly sentinel: readonly Record<string, unknown>[];
} {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      bytes: readFileSync(databaseFile),
      userVersion: readUserVersion(database),
      schema: database.prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      ).all() as unknown as Record<string, unknown>[],
      sentinel: database.prepare(
        'SELECT id, value FROM owner_fencing_sentinel ORDER BY id'
      ).all() as unknown as Record<string, unknown>[]
    };
  } finally {
    database.close();
  }
}

function readApplicationTables(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
}

function readUserVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function readMigrationAudit(database: DatabaseSync): Array<{
  version: number;
  name: string;
  applied_at: string;
}> {
  return database.prepare(
    `SELECT version, name, applied_at
     FROM schema_migrations
     ORDER BY version`
  ).all() as unknown as Array<{ version: number; name: string; applied_at: string }>;
}

function readMigrationAuditFromRoot(root: string): ReturnType<typeof readMigrationAudit> {
  const database = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    return readMigrationAudit(database);
  } finally {
    database.close();
  }
}

function readPersistedCommands(root: string): PersistedCommandRow[] {
  const database = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    return database.prepare(
      `SELECT command_id, command_digest, status, outcome_json
       FROM runtime_commands
       ORDER BY command_id`
    ).all() as unknown as PersistedCommandRow[];
  } finally {
    database.close();
  }
}

function readPersistedOutcomes(root: string): string {
  return readPersistedCommands(root)
    .map((row) => row.outcome_json ?? '')
    .join('\n');
}

function explainQueryPlan(
  database: DatabaseSync,
  sql: string,
  parameter: string | number
): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter) as unknown as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join('\n');
}
