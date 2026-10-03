import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST
} from '@ariadne/protocol/public';

import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

export const PUBLIC_PROJECTION_DB_SCHEMA_VERSION = 3;
export const PUBLIC_PROJECTION_DB_RELATIVE_PATH = path.join(
  'data',
  'public-projection',
  'projection.db'
);

const PUBLIC_PROJECTION_SCHEMA_NAME = 'public_projection_v4_store_v3';

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export function resolvePublicProjectionDatabasePath(dataRoot: string): string {
  if (typeof dataRoot !== 'string' || dataRoot.trim().length === 0) {
    throw new Error('public_projection_data_root_required');
  }
  return path.resolve(dataRoot, PUBLIC_PROJECTION_DB_RELATIVE_PATH);
}

export function openPublicProjectionDatabase(dataRoot: string): {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly ownerLease: SqliteOwnerLease;
  readonly streamId: string;
} {
  const databasePath = resolvePublicProjectionDatabasePath(dataRoot);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const ownerLease = acquireSqliteOwnerLease(databasePath, 'public_projection');
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 0;');
    initializeOrValidatePublicProjectionSchema(database);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    assertPublicProjectionDatabasePragmas(database);
    const metadata = readMetadata(database);
    return { database, databasePath, ownerLease, streamId: metadata.streamId };
  } catch (error) {
    if (database === null) {
      ownerLease.close();
    } else {
      try {
        closeOwnedSqliteDatabase(database, ownerLease);
      } catch {
        // Preserve the opening failure. Shared close fencing retains an
        // uncertain connection and its lease until process exit.
      }
    }
    throw error;
  }
}

function initializeOrValidatePublicProjectionSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version > PUBLIC_PROJECTION_DB_SCHEMA_VERSION) {
    throw new Error(
      `public_projection_schema_newer_than_runtime:${String(version)}:`
      + String(PUBLIC_PROJECTION_DB_SCHEMA_VERSION)
    );
  }
  if (version > 0 && version < PUBLIC_PROJECTION_DB_SCHEMA_VERSION) {
    throw new Error(
      `public_projection_protocol_reset_required:${String(version)}:`
      + String(PUBLIC_PROJECTION_DB_SCHEMA_VERSION)
    );
  }
  if (version === 0) {
    const objects = listSchemaObjects(database);
    if (objects.length !== 0) {
      throw new Error(
        `public_projection_unversioned_schema_not_empty:`
        + objects.map(schemaObjectIdentity).join(',')
      );
    }
    createPublicProjectionSchema(database);
  }
  assertPublicProjectionSchema(database);
}

function createPublicProjectionSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    createPublicProjectionSchemaObjects(database);
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO schema_migrations(version, name, applied_at)
       VALUES (?, ?, ?)`
    ).run(
      PUBLIC_PROJECTION_DB_SCHEMA_VERSION,
      PUBLIC_PROJECTION_SCHEMA_NAME,
      createdAt
    );
    const streamId = randomUUID();
    database.prepare(
      `INSERT INTO projection_metadata(
         singleton_id, contract_version, stream_id, genesis_digest,
         created_at, metadata_digest
       ) VALUES (1, ?, ?, ?, ?, ?)`
    ).run(
      PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId,
      PUBLIC_PROJECTION_GENESIS_DIGEST,
      createdAt,
      metadataDigest(
        PUBLIC_PROJECTION_CONTRACT_VERSION,
        streamId,
        PUBLIC_PROJECTION_GENESIS_DIGEST,
        createdAt
      )
    );
    database.exec(`PRAGMA user_version = ${PUBLIC_PROJECTION_DB_SCHEMA_VERSION};`);
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}

function createPublicProjectionSchemaObjects(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE projection_metadata (
      singleton_id INTEGER NOT NULL PRIMARY KEY CHECK(singleton_id = 1),
      contract_version TEXT NOT NULL,
      stream_id TEXT NOT NULL UNIQUE CHECK(length(stream_id) BETWEEN 1 AND 256),
      genesis_digest TEXT NOT NULL CHECK(
        length(genesis_digest) = 71
        AND substr(genesis_digest, 1, 7) = 'sha256:'
        AND substr(genesis_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      metadata_digest TEXT NOT NULL CHECK(
        length(metadata_digest) = 71
        AND substr(metadata_digest, 1, 7) = 'sha256:'
        AND substr(metadata_digest, 8) NOT GLOB '*[^0-9a-f]*'
      )
    );

    CREATE TABLE projection_commits (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
      source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
      source_cursor INTEGER NOT NULL CHECK(source_cursor > 0),
      contract_version TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      commit_json TEXT NOT NULL CHECK(json_valid(commit_json) AND json_type(commit_json) = 'object'),
      payload_digest TEXT NOT NULL CHECK(
        length(payload_digest) = 71
        AND substr(payload_digest, 1, 7) = 'sha256:'
        AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      history_digest TEXT NOT NULL CHECK(
        length(history_digest) = 71
        AND substr(history_digest, 1, 7) = 'sha256:'
        AND substr(history_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      UNIQUE(source_id, source_cursor)
    );
    CREATE INDEX idx_projection_commits_source
      ON projection_commits(source_id, source_cursor);

    CREATE TABLE projection_source_checkpoints (
      source_id TEXT NOT NULL PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 256),
      source_cursor INTEGER NOT NULL CHECK(source_cursor > 0),
      event_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(event_id) REFERENCES projection_commits(event_id) ON DELETE RESTRICT
    );

    CREATE TABLE projection_versions (
      feature TEXT NOT NULL CHECK(feature IN (
        'sessions', 'messages', 'runs', 'decisions', 'models', 'diagnostics',
        'inference_streams'
      )),
      aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 256),
      aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
      operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
      projected_at TEXT NOT NULL,
      dto_json TEXT CHECK(
        dto_json IS NULL
        OR (json_valid(dto_json) AND json_type(dto_json) = 'object')
      ),
      payload_digest TEXT NOT NULL CHECK(
        length(payload_digest) = 71
        AND substr(payload_digest, 1, 7) = 'sha256:'
        AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      commit_cursor INTEGER NOT NULL,
      change_index INTEGER NOT NULL CHECK(change_index >= 0),
      PRIMARY KEY(feature, aggregate_id, aggregate_version),
      UNIQUE(commit_cursor, change_index),
      FOREIGN KEY(commit_cursor) REFERENCES projection_commits(cursor) ON DELETE RESTRICT,
      CHECK(
        (operation = 'upsert' AND dto_json IS NOT NULL)
        OR (operation = 'delete' AND dto_json IS NULL)
      )
    );
    CREATE INDEX idx_projection_versions_commit
      ON projection_versions(commit_cursor, change_index);

    CREATE TABLE projection_heads (
      feature TEXT NOT NULL CHECK(feature IN (
        'sessions', 'messages', 'runs', 'decisions', 'models', 'diagnostics',
        'inference_streams'
      )),
      aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 256),
      aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
      operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
      projected_at TEXT NOT NULL,
      dto_json TEXT CHECK(
        dto_json IS NULL
        OR (json_valid(dto_json) AND json_type(dto_json) = 'object')
      ),
      payload_digest TEXT NOT NULL CHECK(
        length(payload_digest) = 71
        AND substr(payload_digest, 1, 7) = 'sha256:'
        AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      commit_cursor INTEGER NOT NULL,
      change_index INTEGER NOT NULL CHECK(change_index >= 0),
      PRIMARY KEY(feature, aggregate_id),
      FOREIGN KEY(feature, aggregate_id, aggregate_version)
        REFERENCES projection_versions(feature, aggregate_id, aggregate_version)
        ON DELETE RESTRICT,
      FOREIGN KEY(commit_cursor, change_index)
        REFERENCES projection_versions(commit_cursor, change_index)
        ON DELETE RESTRICT,
      CHECK(
        (operation = 'upsert' AND dto_json IS NOT NULL)
        OR (operation = 'delete' AND dto_json IS NULL)
      )
    );
    CREATE INDEX idx_projection_heads_snapshot
      ON projection_heads(feature, operation, aggregate_id);
  `);
}

function assertPublicProjectionSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version !== PUBLIC_PROJECTION_DB_SCHEMA_VERSION) {
    throw new Error(
      `public_projection_schema_version_mismatch:${String(version)}:`
      + String(PUBLIC_PROJECTION_DB_SCHEMA_VERSION)
    );
  }
  const actual = listSchemaObjects(database);
  const canonical = new DatabaseSync(':memory:');
  let expected: readonly SchemaObject[];
  try {
    canonical.exec('PRAGMA foreign_keys = ON;');
    createPublicProjectionSchemaObjects(canonical);
    expected = listSchemaObjects(canonical);
  } finally {
    canonical.close();
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `public_projection_schema_definition_mismatch:`
      + actual.map(schemaObjectIdentity).join(',')
    );
  }

  const migrations = database.prepare(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  ).all() as unknown as Array<{
    version: number;
    name: string;
    applied_at: string;
  }>;
  if (
    migrations.length !== 1
    || migrations[0]?.version !== PUBLIC_PROJECTION_DB_SCHEMA_VERSION
    || migrations[0]?.name !== PUBLIC_PROJECTION_SCHEMA_NAME
    || !isCanonicalTimestamp(migrations[0]?.applied_at)
  ) {
    throw new Error('public_projection_schema_migration_ledger_invalid');
  }

  const metadata = readMetadata(database);
  if (metadata.createdAt !== migrations[0].applied_at) {
    throw new Error('public_projection_metadata_ledger_mismatch');
  }
  const integrity = database.prepare('PRAGMA integrity_check;').get() as {
    integrity_check: string;
  };
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check;').all();
  if (integrity.integrity_check !== 'ok' || foreignKeyFailures.length !== 0) {
    throw new Error('public_projection_schema_integrity_check_failed');
  }
}

function readMetadata(database: DatabaseSync): {
  readonly streamId: string;
  readonly createdAt: string;
} {
  const rows = database.prepare(
    `SELECT singleton_id, contract_version, stream_id, genesis_digest,
            created_at, metadata_digest
     FROM projection_metadata ORDER BY singleton_id`
  ).all() as unknown as Array<{
    singleton_id: number;
    contract_version: string;
    stream_id: string;
    genesis_digest: string;
    created_at: string;
    metadata_digest: string;
  }>;
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.singleton_id !== 1
    || row.contract_version !== PUBLIC_PROJECTION_CONTRACT_VERSION
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(row.stream_id)
    || row.genesis_digest !== PUBLIC_PROJECTION_GENESIS_DIGEST
    || !isCanonicalTimestamp(row.created_at)
    || row.metadata_digest !== metadataDigest(
      row.contract_version,
      row.stream_id,
      row.genesis_digest,
      row.created_at
    )
  ) {
    throw new Error('public_projection_metadata_invalid');
  }
  return { streamId: row.stream_id, createdAt: row.created_at };
}

function metadataDigest(
  contractVersion: string,
  streamId: string,
  genesisDigest: string,
  createdAt: string
): string {
  return `sha256:${createHash('sha256')
    .update(
      `${contractVersion}\u0000${streamId}\u0000${genesisDigest}\u0000${createdAt}`,
      'utf8'
    )
    .digest('hex')}`;
}

function assertPublicProjectionDatabasePragmas(database: DatabaseSync): void {
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
    throw new Error('public_projection_pragma_verification_failed');
  }
}

function listSchemaObjects(database: DatabaseSync): readonly SchemaObject[] {
  return (database.prepare(
    `SELECT type, name, tbl_name AS tableName, sql
     FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`
  ).all() as unknown as SchemaObject[]).map((entry) => ({
    type: entry.type,
    name: entry.name,
    tableName: entry.tableName,
    sql: normalizeSql(entry.sql)
  }));
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version;').get() as {
    user_version: number;
  };
  const version = Number(row.user_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('public_projection_schema_user_version_invalid');
  }
  return version;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function schemaObjectIdentity(value: SchemaObject): string {
  return `${value.type}:${value.name}:${value.tableName}`;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
