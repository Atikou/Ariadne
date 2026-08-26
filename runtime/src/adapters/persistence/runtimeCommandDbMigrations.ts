import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

interface RuntimeCommandDbMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync) => void;
}

interface SqliteColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const MIGRATION_TABLE_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

const RUNTIME_COMMANDS_TABLE_SQL = `
  CREATE TABLE runtime_commands (
    command_id TEXT PRIMARY KEY,
    command_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'executing', 'completed', 'uncertain'
    )),
    outcome_json TEXT CHECK(
      outcome_json IS NULL OR json_valid(outcome_json)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const RUNTIME_COMMANDS_STATUS_INDEX_SQL = `
  CREATE INDEX idx_runtime_commands_status
    ON runtime_commands(status, updated_at)
`;

export const RUNTIME_COMMAND_DB_SCHEMA_VERSION = 1;
export const RUNTIME_COMMAND_DB_RELATIVE_PATH = path.join(
  'data',
  'runtime-control',
  'runtime-command.db'
);

export const RUNTIME_COMMAND_DB_MIGRATIONS: readonly RuntimeCommandDbMigration[] = [
  {
    version: 1,
    name: 'runtime_command_journal',
    up(database) {
      database.exec(RUNTIME_COMMANDS_TABLE_SQL);
      database.exec(RUNTIME_COMMANDS_STATUS_INDEX_SQL);
    }
  }
];

export function resolveRuntimeCommandDatabasePath(dataRoot: string): string {
  return path.resolve(dataRoot, RUNTIME_COMMAND_DB_RELATIVE_PATH);
}

/**
 * Applies only the Runtime command-journal schema. This intentionally does not
 * use the legacy memory.db migration runner, whose compatibility backfill rules
 * belong to the conversation store and must never infer ownership here.
 */
export function migrateRuntimeCommandDatabase(database: DatabaseSync): void {
  const initialVersion = getUserVersion(database);
  if (initialVersion > RUNTIME_COMMAND_DB_SCHEMA_VERSION) {
    throw new Error(
      `runtime_command_db_schema_newer_than_runtime:${String(initialVersion)}:`
      + String(RUNTIME_COMMAND_DB_SCHEMA_VERSION)
    );
  }

  if (initialVersion === 0) {
    const existingObjects = listApplicationObjects(database);
    if (existingObjects.length > 0) {
      throw new Error(`runtime_command_db_unmanaged_schema:${existingObjects.join(',')}`);
    }
  }

  let currentVersion = initialVersion;
  if (currentVersion < RUNTIME_COMMAND_DB_SCHEMA_VERSION) {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (currentVersion === 0) database.exec(MIGRATION_TABLE_SQL);
      for (const migration of RUNTIME_COMMAND_DB_MIGRATIONS) {
        if (migration.version <= currentVersion) continue;
        if (migration.version !== currentVersion + 1) {
          throw new Error(
            `runtime_command_db_migration_gap:${String(currentVersion)}:`
            + `${String(migration.version)}:${migration.name}`
          );
        }
        migration.up(database);
        database.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`
        ).run(migration.version, migration.name, new Date().toISOString());
        database.exec(`PRAGMA user_version = ${String(migration.version)}`);
        currentVersion = migration.version;
      }
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  assertRuntimeCommandDatabaseSchema(database);
}

export function assertRuntimeCommandDatabaseSchema(database: DatabaseSync): void {
  const version = getUserVersion(database);
  if (version !== RUNTIME_COMMAND_DB_SCHEMA_VERSION) {
    throw new Error(
      `runtime_command_db_schema_version_invalid:${String(version)}:`
      + String(RUNTIME_COMMAND_DB_SCHEMA_VERSION)
    );
  }

  assertExactValues(
    listApplicationTables(database),
    ['runtime_commands', 'schema_migrations'],
    'tables'
  );
  assertExactValues(
    listApplicationIndexes(database),
    ['idx_runtime_commands_status'],
    'indexes'
  );
  assertExactValues(listApplicationViewsAndTriggers(database), [], 'views_or_triggers');
  assertExactColumns(database, 'schema_migrations', [
    { name: 'version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }
  ]);
  assertExactColumns(database, 'runtime_commands', [
    { name: 'command_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'command_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'outcome_json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }
  ]);
  assertSchemaSql(database, 'table', 'schema_migrations', MIGRATION_TABLE_SQL);
  assertSchemaSql(database, 'table', 'runtime_commands', RUNTIME_COMMANDS_TABLE_SQL);
  assertSchemaSql(
    database,
    'index',
    'idx_runtime_commands_status',
    RUNTIME_COMMANDS_STATUS_INDEX_SQL
  );

  const migrations = database.prepare(
    `SELECT version, name, applied_at
     FROM schema_migrations
     ORDER BY version`
  ).all() as unknown as Array<{ version: number; name: string; applied_at: string }>;
  if (
    migrations.length !== RUNTIME_COMMAND_DB_MIGRATIONS.length
    || migrations.some((row, index) => {
      const expected = RUNTIME_COMMAND_DB_MIGRATIONS[index];
      return expected === undefined
        || row.version !== expected.version
        || row.name !== expected.name
        || !isIsoTimestamp(row.applied_at);
    })
  ) {
    throw new Error('runtime_command_db_schema_invalid:migration_audit');
  }

  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity.integrity_check !== 'ok') {
    throw new Error('runtime_command_db_schema_invalid:integrity_check');
  }
}

function getUserVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function listApplicationTables(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
}

function listApplicationObjects(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT type, name
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
       AND type IN ('table', 'index', 'view', 'trigger')
     ORDER BY type, name`
  ).all() as unknown as Array<{ type: string; name: string }>).map(
    (row) => `${row.type}:${row.name}`
  );
}

function listApplicationIndexes(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type='index' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
}

function listApplicationViewsAndTriggers(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT type, name
     FROM sqlite_master
     WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`
  ).all() as unknown as Array<{ type: string; name: string }>).map(
    (row) => `${row.type}:${row.name}`
  );
}

function assertExactColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly SqliteColumn[]
): void {
  const actual = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as SqliteColumn[];
  if (JSON.stringify(actual.map(normalizeColumn)) !== JSON.stringify(expected.map(normalizeColumn))) {
    throw new Error(`runtime_command_db_schema_invalid:${table}_columns`);
  }
}

function normalizeColumn(column: SqliteColumn): SqliteColumn {
  return {
    name: column.name,
    type: column.type.toUpperCase(),
    notnull: Number(column.notnull),
    dflt_value: column.dflt_value,
    pk: Number(column.pk)
  };
}

function assertSchemaSql(
  database: DatabaseSync,
  type: 'table' | 'index',
  name: string,
  expected: string
): void {
  const row = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type=? AND name=?`
  ).get(type, name) as { sql: string | null } | undefined;
  if (!row?.sql || normalizeSql(row.sql) !== normalizeSql(expected)) {
    throw new Error(`runtime_command_db_schema_invalid:${name}_sql`);
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/;$/u, '').trim().toLowerCase();
}

function assertExactValues(actual: string[], expected: string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`runtime_command_db_schema_invalid:${label}:${actual.join(',')}`);
  }
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
