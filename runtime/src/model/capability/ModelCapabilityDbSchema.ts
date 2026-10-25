import type { DatabaseSync } from 'node:sqlite';
import { markAuthorityIntegrityError, markAuthorityUnavailableError } from '../../adapters/persistence/SqliteAuthorityHealth.js';

export const MODEL_CAPABILITY_DB_SCHEMA_VERSION = 1;
export const MODEL_CAPABILITY_TABLES = Object.freeze({
  model_capability_metadata: 'CREATE TABLE model_capability_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL)',
  model_capability_qualification: `CREATE TABLE model_capability_qualification (
    provider_id TEXT NOT NULL,model_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
    adapter_protocol_version INTEGER NOT NULL,report_json TEXT NOT NULL,tested_at TEXT,
    PRIMARY KEY(provider_id,model_id,fingerprint)
  )`
});
/** Recognize the old metadata-1 cache without treating unknown databases as disposable. */
export function initializeModelCapabilitySchema(database: DatabaseSync, audit?: (database: DatabaseSync) => void): void {
  const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 0 && version !== MODEL_CAPABILITY_DB_SCHEMA_VERSION) throw markAuthorityUnavailableError('inference', new Error(`model_capability_schema_unsupported:${version}`));
  const objects = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const hasMetadata = objects.some(row => row.name === 'model_capability_metadata');
  if (hasMetadata) {
    database.exec(version === 0 ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
    try {
      assertModelCapabilityDatabaseSchema(database); audit?.(database);
      if (version === 0) database.exec('PRAGMA user_version=1;');
      database.exec('COMMIT;');
    } catch (error) { rollback(database, error); }
    return;
  }
  if (objects.length > 0 || version !== 0) throw markAuthorityUnavailableError('inference', new Error('model_capability_database_unmanaged'));
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ${Object.values(MODEL_CAPABILITY_TABLES).join(';')};
      INSERT INTO model_capability_metadata VALUES(1,1);
      PRAGMA user_version=1;
    `);
    audit?.(database); database.exec('COMMIT;');
  } catch (error) { rollback(database, error); }
}

/** Read-only validation for offline naming upgrades; never creates or promotes metadata. */
export function assertModelCapabilityDatabaseSchema(database: DatabaseSync): void {
  const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 0 && version !== MODEL_CAPABILITY_DB_SCHEMA_VERSION) throw markAuthorityUnavailableError('inference', new Error(`model_capability_schema_unsupported:${version}`));
  const metadata = database.prepare('SELECT singleton,schema_version FROM model_capability_metadata').all();
  if (metadata.length !== 1 || metadata[0]!.singleton !== 1 || metadata[0]!.schema_version !== MODEL_CAPABILITY_DB_SCHEMA_VERSION) {
    throw markAuthorityUnavailableError('inference', new Error('model_capability_metadata_schema_unsupported'));
  }
  for (const [table, columns] of Object.entries({
    model_capability_metadata: ['singleton','schema_version'],
    model_capability_qualification: ['provider_id','model_id','fingerprint','adapter_protocol_version','report_json','tested_at']
  })) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) throw markAuthorityIntegrityError('inference', new Error('model_capability_source_structure_invalid'));
  }
}
function rollback(database: DatabaseSync, error: unknown): never {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); }
    catch (rollbackError) { throw markAuthorityUnavailableError('inference',
      new AggregateError([error, rollbackError], 'model_capability_rollback_failed')); }
  }
  throw error;
}
