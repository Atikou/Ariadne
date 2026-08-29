import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateEmptyAgentControlV5ToV6 } from '../src/adapters/persistence/AgentControlOfflineMigration.js';
import { migrateAgentControlV6ToV7 } from '../src/adapters/persistence/AgentControlV6ToV7Migration.js';
import {
  openAgentControlDatabase,
  resolveAgentControlDatabasePath
} from '../src/adapters/persistence/agentControlDbSchema.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Control offline migration', () => {
  it('backs up and migrates an empty schema-v5 ledger through v6 to canonical v7', () => {
    const root = createV5Fixture();

    const result = migrateEmptyAgentControlV5ToV6(root);

    expect(result).toMatchObject({
      fromVersion: 5,
      toVersion: 6,
      migrated: true
    });
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    const v6 = new DatabaseSync(resolveAgentControlDatabasePath(root), { readOnly: true });
    expect(v6.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    v6.close();

    expect(migrateAgentControlV6ToV7(root)).toMatchObject({
      fromVersion: 6,
      toVersion: 7,
      migrated: true
    });
    const reopened = openAgentControlDatabase(root);
    try {
      expect(reopened.database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 7
      });
    } finally {
      closeOwnedSqliteDatabase(reopened.database, reopened.ownerLease);
    }
  });

  it('refuses to reinterpret a non-empty schema-v5 ledger', () => {
    const root = createV5Fixture();
    const database = new DatabaseSync(resolveAgentControlDatabasePath(root));
    database.prepare(
      `INSERT INTO agent_v3_runs(
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-run',
      1,
      'completed',
      JSON.stringify({
        turns: [],
        binding: {
          toolCatalog: {
            catalogId: 'legacy-catalog',
            revision: 1,
            digest: `sha256:${'a'.repeat(64)}`
          }
        }
      }),
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z'
    );
    database.close();

    expect(() => migrateEmptyAgentControlV5ToV6(root)).toThrow(
      'agent_control_offline_migration_nonempty:1'
    );
    const unchanged = new DatabaseSync(resolveAgentControlDatabasePath(root), {
      readOnly: true
    });
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    unchanged.close();
  });

  it('widens only the protected Directive payload contract while preserving a non-empty v6 ledger', () => {
    const root = createV5Fixture();
    migrateEmptyAgentControlV5ToV6(root);
    const databasePath = resolveAgentControlDatabasePath(root);
    const before = new DatabaseSync(databasePath);
    const aggregate = JSON.stringify({
      turns: [],
      binding: {
        toolCatalog: {
          catalogId: 'legacy-catalog',
          revision: 1,
          digest: `sha256:${'a'.repeat(64)}`
        }
      }
    });
    before.prepare(
      `INSERT INTO agent_v3_runs(
         run_id, version, state_status, aggregate_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'preserved-v6-run',
      1,
      'completed',
      aggregate,
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z'
    );
    before.close();

    const result = migrateAgentControlV6ToV7(root);
    expect(result).toMatchObject({ fromVersion: 6, toVersion: 7, migrated: true });
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);

    const after = new DatabaseSync(databasePath, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(after.prepare(
      'SELECT aggregate_json FROM agent_v3_runs WHERE run_id=?'
    ).get('preserved-v6-run')).toEqual({ aggregate_json: aggregate });
    const directiveTable = after.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type='table' AND name='agent_v3_directive_payloads'`
    ).get() as { sql: string };
    expect(directiveTable.sql).toContain("'user_question'");
    after.close();
  });
});

function createV5Fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-agent-control-migrate-'));
  roots.push(root);
  const initialized = openAgentControlDatabase(root);
  closeOwnedSqliteDatabase(initialized.database, initialized.ownerLease);
  const database = new DatabaseSync(resolveAgentControlDatabasePath(root));
  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN IMMEDIATE;
    DROP INDEX idx_agent_v3_runs_waiting_input;
    DROP INDEX idx_agent_v3_runs_status;
    DROP INDEX idx_agent_v3_runs_recovery;
    ALTER TABLE agent_v3_runs RENAME TO agent_v3_runs_v6;

    CREATE TABLE agent_v3_runs (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version > 0),
      state_status TEXT NOT NULL CHECK(state_status IN (
        'queued', 'running', 'waiting', 'recovering',
        'waiting_children', 'cancelling',
        'completed', 'failed', 'cancelled'
      )),
      aggregate_json TEXT NOT NULL CHECK(
        json_valid(aggregate_json)
        AND COALESCE(json_type(aggregate_json, '$.turns') = 'array', 0)
        AND COALESCE(json_type(aggregate_json, '$.binding.toolCatalog') = 'object', 0)
        AND COALESCE(
          json_type(aggregate_json, '$.binding.toolCatalog.catalogId') = 'text'
          AND length(json_extract(aggregate_json, '$.binding.toolCatalog.catalogId')) > 0,
          0
        )
        AND COALESCE(
          json_type(aggregate_json, '$.binding.toolCatalog.revision') = 'integer'
          AND json_extract(aggregate_json, '$.binding.toolCatalog.revision') > 0,
          0
        )
        AND COALESCE(
          json_type(aggregate_json, '$.binding.toolCatalog.digest') = 'text'
          AND length(json_extract(aggregate_json, '$.binding.toolCatalog.digest')) = 71
          AND substr(json_extract(aggregate_json, '$.binding.toolCatalog.digest'), 1, 7) = 'sha256:'
          AND substr(json_extract(aggregate_json, '$.binding.toolCatalog.digest'), 8)
            NOT GLOB '*[^0-9a-f]*',
          0
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO agent_v3_runs(
      run_id, version, state_status, aggregate_json, created_at, updated_at
    )
    SELECT run_id, version, state_status, aggregate_json, created_at, updated_at
    FROM agent_v3_runs_v6;
    DROP TABLE agent_v3_runs_v6;

    CREATE INDEX idx_agent_v3_runs_status
      ON agent_v3_runs(state_status, updated_at DESC);
    CREATE INDEX idx_agent_v3_runs_recovery
      ON agent_v3_runs(created_at, run_id)
      WHERE state_status IN (
        'queued', 'running', 'waiting', 'recovering',
        'waiting_children', 'cancelling'
      );

    DROP INDEX idx_agent_v3_directive_payloads_run;
    ALTER TABLE agent_v3_directive_payloads
      RENAME TO agent_v3_directive_payloads_v7;
    CREATE TABLE agent_v3_directive_payloads (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      run_version INTEGER NOT NULL CHECK(run_version > 0),
      payload_kind TEXT NOT NULL CHECK(payload_kind IN (
        'response_content', 'checkpoint_reason',
        'completion_output', 'failure_message'
      )),
      directive_digest TEXT NOT NULL CHECK(
        length(directive_digest) = 71
        AND substr(directive_digest, 1, 7) = 'sha256:'
      ),
      content_digest TEXT NOT NULL CHECK(
        length(content_digest) = 71
        AND substr(content_digest, 1, 7) = 'sha256:'
      ),
      codec_id TEXT NOT NULL CHECK(length(codec_id) > 0),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(command_id, run_id, run_version)
        REFERENCES agent_v3_command_runs(command_id, run_id, resulting_version)
        ON DELETE RESTRICT,
      UNIQUE(command_id, run_id, artifact_id)
    );
    INSERT INTO agent_v3_directive_payloads(
      artifact_id, run_id, command_id, run_version, payload_kind,
      directive_digest, content_digest, codec_id, payload_json, recorded_at
    )
    SELECT artifact_id, run_id, command_id, run_version, payload_kind,
           directive_digest, content_digest, codec_id, payload_json, recorded_at
    FROM agent_v3_directive_payloads_v7;
    DROP TABLE agent_v3_directive_payloads_v7;
    CREATE INDEX idx_agent_v3_directive_payloads_run
      ON agent_v3_directive_payloads(run_id, run_version, artifact_id);

    DELETE FROM schema_migrations WHERE version >= 6;
    PRAGMA user_version = 5;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
  database.close();
  return root;
}
