import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  acquireSqliteOwnerLease,
  closeOwnedSqliteDatabase,
  type SqliteOwnerLease
} from './SqliteOwnerLease.js';

export const CONVERSATION_DB_SCHEMA_VERSION = 2;
export const CONVERSATION_DB_RELATIVE_PATH = path.join(
  'data',
  'conversation',
  'conversation.db'
);

const CONVERSATION_SCHEMA_MIGRATION_NAME =
  'conversation_authority_v2_agent_start_failure';

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export function resolveConversationDatabasePath(dataRoot: string): string {
  if (typeof dataRoot !== 'string' || dataRoot.trim().length === 0) {
    throw new Error('conversation_data_root_required');
  }
  return path.resolve(dataRoot, CONVERSATION_DB_RELATIVE_PATH);
}

/**
 * Opens the Conversation-owned store. Runtime creates schema v1 only for a
 * pristine file; every version or structure ambiguity is an offline concern.
 */
export function openConversationDatabase(dataRoot: string): {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly ownerLease: SqliteOwnerLease;
} {
  const databasePath = resolveConversationDatabasePath(dataRoot);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const ownerLease = acquireSqliteOwnerLease(databasePath, 'conversation');
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 0;');
    initializeOrValidateConversationSchema(database);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    assertConversationDatabasePragmas(database);
    return { database, databasePath, ownerLease };
  } catch (error) {
    if (database === null) {
      ownerLease.close();
    } else {
      try {
        closeOwnedSqliteDatabase(database, ownerLease);
      } catch {
        // The opening error stays authoritative. A connection whose close is
        // uncertain remains strongly referenced and fenced until process exit.
      }
    }
    throw error;
  }
}

function initializeOrValidateConversationSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version > CONVERSATION_DB_SCHEMA_VERSION) {
    throw new Error(
      `conversation_schema_newer_than_runtime:${String(version)}:`
      + String(CONVERSATION_DB_SCHEMA_VERSION)
    );
  }
  if (version === 1 && CONVERSATION_DB_SCHEMA_VERSION === 2) {
    migrateConversationSchemaV1ToV2(database);
  } else if (version > 0 && version < CONVERSATION_DB_SCHEMA_VERSION) {
    throw new Error(
      `conversation_offline_migration_required:${String(version)}:`
      + String(CONVERSATION_DB_SCHEMA_VERSION)
    );
  }
  if (version === 0) {
    const objects = listSchemaObjects(database);
    if (objects.length !== 0) {
      throw new Error(
        `conversation_unversioned_schema_not_empty:`
        + objects.map(schemaObjectIdentity).join(',')
      );
    }
    createConversationSchema(database);
  }
  assertConversationSchema(database);
}

function migrateConversationSchemaV1ToV2(database: DatabaseSync): void {
  const rebuilt = [
    'conversation_events',
    'conversation_commands',
    'conversation_handoff_outbox',
    'conversation_handoff_sagas'
  ] as const;
  const canonical = new DatabaseSync(':memory:');
  let definitions: readonly SchemaObject[];
  try {
    createConversationSchemaObjects(canonical);
    definitions = listSchemaObjects(canonical).filter((object) =>
      rebuilt.includes(object.tableName as typeof rebuilt[number])
    );
  } finally {
    canonical.close();
  }
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('PRAGMA legacy_alter_table = ON;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const table of rebuilt) {
      database.exec(`ALTER TABLE ${table} RENAME TO __v1_${table};`);
    }
    const oldIndexes = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='index' AND tbl_name LIKE '__v1_%' AND sql IS NOT NULL`
    ).all() as unknown as Array<{ readonly name: string }>;
    for (const { name } of oldIndexes) {
      database.exec(`DROP INDEX ${quoteIdentifier(name)};`);
    }
    for (const object of definitions.filter((item) => item.type === 'table')) {
      database.exec(`${object.sql};`);
    }
    for (const table of rebuilt) {
      const columns = database.prepare(`PRAGMA table_info(${table});`).all() as unknown as Array<{ readonly name: string }>;
      const names = columns.map((column) => quoteIdentifier(column.name)).join(', ');
      database.exec(
        `INSERT INTO ${table}(${names}) SELECT ${names} FROM __v1_${table};`
      );
    }
    for (const table of rebuilt) database.exec(`DROP TABLE __v1_${table};`);
    for (const object of definitions.filter((item) => item.type === 'index')) {
      database.exec(`${object.sql};`);
    }
    database.prepare('DELETE FROM schema_migrations;').run();
    database.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)'
    ).run(2, CONVERSATION_SCHEMA_MIGRATION_NAME, new Date().toISOString());
    database.exec('PRAGMA user_version = 2;');
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.exec('PRAGMA legacy_alter_table = OFF;');
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function createConversationSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    createConversationSchemaObjects(database);
    database.prepare(
      `INSERT INTO schema_migrations(version, name, applied_at)
       VALUES (?, ?, ?)`
    ).run(
      CONVERSATION_DB_SCHEMA_VERSION,
      CONVERSATION_SCHEMA_MIGRATION_NAME,
      new Date().toISOString()
    );
    database.exec(`PRAGMA user_version = ${CONVERSATION_DB_SCHEMA_VERSION};`);
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}

function createConversationSchemaObjects(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE conversation_sessions (
      session_id TEXT PRIMARY KEY CHECK(length(session_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      version INTEGER NOT NULL CHECK(version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, workspace_id),
      CHECK(updated_at >= created_at)
    );
    CREATE INDEX idx_conversation_sessions_workspace
      ON conversation_sessions(workspace_id, updated_at DESC);

    CREATE TABLE conversation_message_heads (
      message_id TEXT PRIMARY KEY CHECK(length(message_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      latest_version INTEGER NOT NULL CHECK(latest_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(message_id, session_id, workspace_id),
      FOREIGN KEY(session_id, workspace_id)
        REFERENCES conversation_sessions(session_id, workspace_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(message_id, latest_version)
        REFERENCES conversation_message_versions(message_id, version)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(updated_at >= created_at)
    );
    CREATE INDEX idx_conversation_message_heads_session
      ON conversation_message_heads(session_id, created_at, message_id);

    CREATE TABLE conversation_message_versions (
      message_id TEXT NOT NULL CHECK(length(message_id) BETWEEN 1 AND 256),
      version INTEGER NOT NULL CHECK(version > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      content_digest TEXT NOT NULL CHECK(
        length(content_digest) = 71
        AND substr(content_digest, 1, 7) = 'sha256:'
        AND substr(content_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      PRIMARY KEY(message_id, version),
      UNIQUE(message_id, version, session_id, workspace_id),
      UNIQUE(
        message_id, version, session_id, workspace_id, content_digest
      ),
      FOREIGN KEY(message_id, session_id, workspace_id)
        REFERENCES conversation_message_heads(message_id, session_id, workspace_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX idx_conversation_message_versions_session
      ON conversation_message_versions(session_id, created_at, message_id, version);

    CREATE TRIGGER conversation_message_versions_no_update
    BEFORE UPDATE ON conversation_message_versions
    BEGIN
      SELECT RAISE(ABORT, 'conversation_message_version_immutable');
    END;

    CREATE TRIGGER conversation_message_versions_no_delete
    BEFORE DELETE ON conversation_message_versions
    BEGIN
      SELECT RAISE(ABORT, 'conversation_message_version_immutable');
    END;

    CREATE TABLE conversation_commands (
      command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 256),
      command_kind TEXT NOT NULL CHECK(command_kind IN (
        'conversation.create_session', 'conversation.accept_user_message',
        'conversation.project_agent_result',
        'conversation.project_agent_start_failure'
      )),
      command_fingerprint TEXT NOT NULL CHECK(
        length(command_fingerprint) = 71
        AND substr(command_fingerprint, 1, 7) = 'sha256:'
        AND substr(command_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      expected_session_version INTEGER,
      resulting_session_version INTEGER NOT NULL CHECK(resulting_session_version > 0),
      message_id TEXT,
      message_version INTEGER,
      saga_id TEXT,
      saga_version INTEGER,
      handoff_command_id TEXT,
      handoff_inbox_event_id TEXT,
      handoff_outbox_message_id TEXT,
      run_id TEXT,
      run_version INTEGER,
      result_status TEXT,
      source_run_event_id TEXT,
      committed_at TEXT NOT NULL,
      UNIQUE(
        command_id, event_id, session_id, workspace_id,
        resulting_session_version
      ),
      FOREIGN KEY(session_id, workspace_id)
        REFERENCES conversation_sessions(session_id, workspace_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(message_id, message_version, session_id, workspace_id)
        REFERENCES conversation_message_versions(
          message_id, version, session_id, workspace_id
        ) ON DELETE RESTRICT,
      FOREIGN KEY(saga_id) REFERENCES conversation_handoff_sagas(saga_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(handoff_command_id, saga_id, saga_version)
        REFERENCES conversation_handoff_commands(
          command_id, saga_id, resulting_version
        ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(handoff_inbox_event_id, handoff_command_id, saga_id)
        REFERENCES conversation_handoff_inbox(
          inbox_event_id, command_id, saga_id
        ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(
        handoff_outbox_message_id, handoff_command_id, saga_id, saga_version
      ) REFERENCES conversation_handoff_outbox(
        message_id, command_id, saga_id, saga_version
      ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(
        (
          command_kind = 'conversation.create_session'
          AND expected_session_version IS NULL
          AND resulting_session_version = 1
          AND message_id IS NULL AND message_version IS NULL AND saga_id IS NULL
          AND saga_version IS NULL AND handoff_command_id IS NULL
          AND handoff_inbox_event_id IS NULL
          AND handoff_outbox_message_id IS NULL
          AND run_id IS NULL AND run_version IS NULL
          AND result_status IS NULL AND source_run_event_id IS NULL
        )
        OR
        (
          command_kind = 'conversation.accept_user_message'
          AND expected_session_version > 0
          AND resulting_session_version = expected_session_version + 1
          AND message_id IS NOT NULL AND message_version > 0 AND saga_id IS NOT NULL
          AND saga_version IS NULL AND handoff_command_id IS NULL
          AND handoff_inbox_event_id IS NULL
          AND handoff_outbox_message_id IS NULL
          AND run_id IS NULL AND run_version IS NULL
          AND result_status IS NULL AND source_run_event_id IS NULL
        )
        OR
        (
          command_kind = 'conversation.project_agent_result'
          AND expected_session_version > 0
          AND resulting_session_version = expected_session_version + 1
          AND message_id IS NOT NULL AND message_version > 0
          AND saga_id IS NOT NULL AND saga_version > 0
          AND handoff_command_id IS NOT NULL
          AND handoff_inbox_event_id IS NOT NULL
          AND handoff_outbox_message_id IS NOT NULL
          AND run_id IS NOT NULL AND run_version > 0
          AND result_status IN ('completed', 'failed', 'cancelled')
          AND source_run_event_id IS NOT NULL
        )
        OR
        (
          command_kind = 'conversation.project_agent_start_failure'
          AND expected_session_version > 0
          AND resulting_session_version = expected_session_version + 1
          AND message_id IS NOT NULL AND message_version > 0
          AND saga_id IS NOT NULL AND saga_version > 0
          AND handoff_command_id IS NOT NULL
          AND handoff_inbox_event_id IS NOT NULL
          AND handoff_outbox_message_id IS NOT NULL
          AND run_id IS NOT NULL AND run_version IS NULL
          AND result_status IS NULL AND source_run_event_id IS NOT NULL
        )
      )
    );
    CREATE INDEX idx_conversation_commands_session
      ON conversation_commands(session_id, resulting_session_version);

    CREATE TABLE conversation_events (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 256),
      command_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_version INTEGER NOT NULL CHECK(session_version > 0),
      event_kind TEXT NOT NULL CHECK(event_kind IN (
        'conversation.session.created', 'conversation.user_message.accepted',
        'conversation.agent_result.projected', 'conversation.agent_start.failed'
      )),
      event_json TEXT NOT NULL CHECK(json_valid(event_json)),
      occurred_at TEXT NOT NULL,
      FOREIGN KEY(
        command_id, event_id, session_id, workspace_id, session_version
      ) REFERENCES conversation_commands(
        command_id, event_id, session_id, workspace_id,
        resulting_session_version
      ) ON DELETE RESTRICT,
      FOREIGN KEY(session_id, workspace_id)
        REFERENCES conversation_sessions(session_id, workspace_id)
        ON DELETE RESTRICT,
      UNIQUE(session_id, session_version)
    );
    CREATE INDEX idx_conversation_events_session
      ON conversation_events(session_id, session_version);

    CREATE TABLE conversation_handoff_sagas (
      saga_id TEXT PRIMARY KEY CHECK(length(saga_id) BETWEEN 1 AND 256),
      version INTEGER NOT NULL CHECK(version > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      message_id TEXT NOT NULL CHECK(length(message_id) BETWEEN 1 AND 256),
      message_version INTEGER NOT NULL CHECK(message_version > 0),
      objective_digest TEXT NOT NULL CHECK(
        length(objective_digest) = 71
        AND substr(objective_digest, 1, 7) = 'sha256:'
        AND substr(objective_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      stage_kind TEXT NOT NULL CHECK(stage_kind IN (
        'message_accepted', 'agent_run_requested',
        'agent_run_linked', 'agent_result_projected', 'agent_start_failed'
      )),
      saga_json TEXT NOT NULL CHECK(json_valid(saga_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(message_id, message_version, session_id, workspace_id),
      FOREIGN KEY(
        message_id, message_version, session_id, workspace_id,
        objective_digest
      )
        REFERENCES conversation_message_versions(
          message_id, version, session_id, workspace_id, content_digest
        ) ON DELETE RESTRICT
    );
    CREATE INDEX idx_conversation_handoff_session
      ON conversation_handoff_sagas(session_id, updated_at DESC);

    CREATE TABLE conversation_handoff_commands (
      command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 256),
      command_fingerprint TEXT NOT NULL CHECK(
        length(command_fingerprint) = 71
        AND substr(command_fingerprint, 1, 7) = 'sha256:'
        AND substr(command_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      saga_id TEXT NOT NULL,
      resulting_version INTEGER NOT NULL CHECK(resulting_version > 0),
      result_saga_json TEXT NOT NULL CHECK(json_valid(result_saga_json)),
      committed_at TEXT NOT NULL,
      FOREIGN KEY(saga_id) REFERENCES conversation_handoff_sagas(saga_id)
        ON DELETE RESTRICT,
      UNIQUE(saga_id, resulting_version),
      UNIQUE(command_id, saga_id, resulting_version)
    );
    CREATE INDEX idx_conversation_handoff_commands_saga
      ON conversation_handoff_commands(saga_id, resulting_version);

    CREATE TABLE conversation_handoff_inbox (
      inbox_event_id TEXT PRIMARY KEY CHECK(length(inbox_event_id) BETWEEN 1 AND 256),
      command_id TEXT NOT NULL UNIQUE,
      saga_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      FOREIGN KEY(command_id) REFERENCES conversation_handoff_commands(command_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(saga_id) REFERENCES conversation_handoff_sagas(saga_id)
        ON DELETE RESTRICT,
      UNIQUE(inbox_event_id, command_id, saga_id)
    );

    CREATE TABLE conversation_handoff_events (
      command_id TEXT PRIMARY KEY,
      saga_id TEXT NOT NULL,
      saga_version INTEGER NOT NULL CHECK(saga_version > 0),
      event_json TEXT NOT NULL CHECK(json_valid(event_json)),
      occurred_at TEXT NOT NULL,
      FOREIGN KEY(command_id) REFERENCES conversation_handoff_commands(command_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(saga_id) REFERENCES conversation_handoff_sagas(saga_id)
        ON DELETE RESTRICT,
      UNIQUE(saga_id, saga_version)
    );

    CREATE TABLE conversation_handoff_outbox (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE CHECK(length(message_id) BETWEEN 1 AND 256),
      command_id TEXT NOT NULL UNIQUE,
      saga_id TEXT NOT NULL,
      saga_version INTEGER NOT NULL CHECK(saga_version > 0),
      message_kind TEXT NOT NULL CHECK(message_kind IN (
        'conversation.message.accepted', 'agent.run.requested',
        'conversation.agent_run.linked',
        'conversation.agent_result.projected',
        'conversation.agent_start.failed'
      )),
      message_json TEXT NOT NULL CHECK(json_valid(message_json)),
      created_at TEXT NOT NULL,
      published_at TEXT,
      published_claim_id TEXT,
      claim_id TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      claim_attempts INTEGER NOT NULL DEFAULT 0 CHECK(claim_attempts >= 0),
      FOREIGN KEY(command_id) REFERENCES conversation_handoff_commands(command_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(saga_id) REFERENCES conversation_handoff_sagas(saga_id)
        ON DELETE RESTRICT,
      UNIQUE(saga_id, saga_version),
      UNIQUE(message_id, command_id, saga_id, saga_version),
      CHECK(
        (claim_id IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL)
        OR
        (claim_id IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL)
      ),
      CHECK(published_at IS NULL OR claim_id IS NULL)
    );
    CREATE INDEX idx_conversation_handoff_outbox_pending
      ON conversation_handoff_outbox(published_at, claim_expires_at, cursor);
    CREATE INDEX idx_conversation_handoff_outbox_claim
      ON conversation_handoff_outbox(claim_id, published_at, cursor);
  `);
}

function assertConversationSchema(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version !== CONVERSATION_DB_SCHEMA_VERSION) {
    throw new Error(
      `conversation_schema_version_mismatch:${String(version)}:`
      + String(CONVERSATION_DB_SCHEMA_VERSION)
    );
  }
  const actual = listSchemaObjects(database);
  const canonicalDatabase = new DatabaseSync(':memory:');
  let expected: readonly SchemaObject[];
  try {
    createConversationSchemaObjects(canonicalDatabase);
    expected = listSchemaObjects(canonicalDatabase);
  } finally {
    canonicalDatabase.close();
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `conversation_schema_definition_mismatch:`
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
    || migrations[0]?.version !== CONVERSATION_DB_SCHEMA_VERSION
    || migrations[0]?.name !== CONVERSATION_SCHEMA_MIGRATION_NAME
    || !isCanonicalTimestamp(migrations[0]?.applied_at)
  ) {
    throw new Error('conversation_schema_migration_ledger_invalid');
  }
  const integrity = database.prepare('PRAGMA integrity_check;').get() as {
    integrity_check: string;
  };
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check;').all();
  if (integrity.integrity_check !== 'ok' || foreignKeyFailures.length !== 0) {
    throw new Error('conversation_schema_integrity_check_failed');
  }
}

function assertConversationDatabasePragmas(database: DatabaseSync): void {
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
    throw new Error('conversation_pragma_verification_failed');
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
    throw new Error('conversation_schema_user_version_invalid');
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
