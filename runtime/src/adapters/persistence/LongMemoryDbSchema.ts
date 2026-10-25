import type { DatabaseSync } from 'node:sqlite';
import { auditLongMemoryAuthority } from './LongMemoryAuthorityAudit.js';
import { markAuthorityUnavailableError } from './SqliteAuthorityHealth.js';

export const LONG_MEMORY_DB_SCHEMA_VERSION = 1;
export function initializeLongMemorySchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === LONG_MEMORY_DB_SCHEMA_VERSION) {
    database.exec('BEGIN;');
    try { auditLongMemoryAuthority(database); database.exec('COMMIT;'); }
    catch (error) { rollback(database, error); } return;
  }
  if (version !== 0) throw markAuthorityUnavailableError('memory', new Error(`long_memory_schema_unsupported:${String(version)}`));
  if (database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())
    throw markAuthorityUnavailableError('memory', new Error('long_memory_unversioned_database_unsupported'));
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE long_memories (
        memory_id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('global','workspace','session')),
        scope_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0), status TEXT NOT NULL CHECK(status IN ('candidate','active','inactive','deleted')),
        payload_json TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        retention_until TEXT, CHECK((status='deleted' AND payload_json IS NULL) OR (status<>'deleted' AND json_valid(payload_json)))
      );
      CREATE INDEX long_memory_scope ON long_memories(scope,scope_id,status,updated_at,memory_id);
      CREATE VIRTUAL TABLE long_memory_fts USING fts5(memory_id UNINDEXED,title,content,tokenize='unicode61');
      CREATE TABLE long_memory_vectors (
        memory_id TEXT PRIMARY KEY REFERENCES long_memories(memory_id), memory_version INTEGER NOT NULL,
        space_id TEXT NOT NULL, dimension INTEGER NOT NULL CHECK(dimension>0), vector_json TEXT NOT NULL CHECK(json_valid(vector_json))
      );
      CREATE TABLE long_memory_commands (
        command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), committed_at TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `);
    auditLongMemoryAuthority(database); database.exec('COMMIT;');
  } catch (error) { rollback(database, error); }
}
function rollback(database: DatabaseSync, error: unknown): never {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'long_memory_schema_rollback_failed'); }
  }
  throw error;
}
