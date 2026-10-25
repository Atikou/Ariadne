import type { DatabaseSync } from 'node:sqlite';
import { assertPublicProjectionSchema, PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION } from './PublicProjectionDbSchema.js';
import { createRunDocumentSchemaObjects, RUN_DOCUMENT_SCHEMA_NAME } from './RunDocumentSchemaLayout.js';

/** Runs on the sole Projection owner's connection. The owner supplies the
 * complete immutable-history audit, avoiding a dependency on its adapter. */
export function upgradeRunDocumentSchema(database: DatabaseSync,
  audit: (database: DatabaseSync) => void, beforeCommit?: () => void): void {
  if (database.isTransaction) throw new Error('run_document_migration_transaction_active');
  database.exec('BEGIN IMMEDIATE;');
  try {
    assertPublicProjectionSchema(database);
    audit(database);
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION) {
      createRunDocumentSchemaObjects(database);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION, RUN_DOCUMENT_SCHEMA_NAME, new Date().toISOString());
      database.exec('PRAGMA user_version=' + PUBLIC_PROJECTION_CURRENT_DB_SCHEMA_VERSION + ';');
      assertPublicProjectionSchema(database);
    }
    beforeCommit?.();
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}
