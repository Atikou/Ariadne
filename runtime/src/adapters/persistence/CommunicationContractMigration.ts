import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertPublicProjectionCommit, canonicalPublicProjectionJson,
  PUBLIC_PROJECTION_CONTRACT_VERSION, PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN
} from '@ariadne/protocol/public';
import { fixedPersistedCommandKind, readPersistedRuntimeResult } from '@ariadne/protocol/compatibility';
import { DATABASE_PATHS } from './DatabasePaths.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase, type SqliteOwnerLease } from './SqliteOwnerLease.js';
import { assertPublicProjectionSchema } from './PublicProjectionDbSchema.js';
import { auditStoredProjectionState } from './SqlitePublicProjectionStore.js';
import { assertProductivityTaskIsolationSchemaV3 } from './ProductivityTaskIsolationSchemaV3.js';
import { assertProductivitySqliteIntegrity } from './ProductivityAuthorityAudit.js';
import { SqliteProductivityTaskIsolation } from './SqliteProductivityTaskIsolation.js';

const SOURCE_CONTRACT = '4.0';
type Owner = 'publicProjection' | 'productivity' | 'runtimeCommand' | 'longMemory';
interface OwnedDatabase { owner: Owner; file: string; lease: SqliteOwnerLease; database: DatabaseSync; backupPath?: string }
interface CommitRow {
  cursor: number; event_id: string; source_id: string; source_cursor: number; contract_version: string;
  occurred_at: string; commit_json: string; payload_digest: string; history_digest: string;
}
const layout = JSON.parse(readFileSync(new URL('../../../config/database-layout.json', import.meta.url), 'utf8')) as {
  owners: { owner: string; schemaMetadataVersion: number; schemaDigest: string }[];
};

/** Read-only activation fence, before any Runtime business connection may mutate a journal. */
export function assertCommunicationContractReady(dataRoot: string): void {
  const file = path.resolve(dataRoot, DATABASE_PATHS.publicProjection);
  if (!existsSync(file)) return;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare('SELECT contract_version FROM projection_metadata WHERE singleton_id=1').get();
    if (row?.contract_version !== PUBLIC_PROJECTION_CONTRACT_VERSION) {
      throw new Error('communication_contract_offline_migration_required');
    }
  } finally { database.close(); }
}

/**
 * Offline data-format upgrade, with unchanged physical schemas and durable recovery copies.
 * Projection metadata is the activation marker and commits LAST. A failure after a domain
 * commit keeps the old marker; rerunning safely finishes the idempotent receipt translations.
 */
export function migrateCommunicationContract(dataRoot: string): {
  migrated: boolean; contractVersion: string; backups: { owner: string; path: string }[];
} {
  if (!path.isAbsolute(dataRoot)) throw new Error('communication_migration_absolute_root_required');
  const projectionPath = path.join(dataRoot, DATABASE_PATHS.publicProjection);
  if (!existsSync(projectionPath)) throw new Error('communication_migration_projection_missing');
  const owners: Owner[] = ['publicProjection', 'productivity', 'runtimeCommand', 'longMemory'];
  const opened: OwnedDatabase[] = [];
  try {
    // Acquire every existing owner before opening any writable business connection.
    for (const owner of owners) {
      const file = path.join(dataRoot, DATABASE_PATHS[owner]);
      if (!existsSync(file)) continue;
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('communication_migration_regular_database_required');
      const lease = acquireSqliteOwnerLease(file, 'communication-contract');
      try { opened.push({ owner, file, lease, database: new DatabaseSync(file, { readOnly: true }) }); }
      catch (error) { lease.close(); throw error; }
    }
    for (const entry of opened) assertFrozenLayout(entry);
    const projection = opened.find(entry => entry.owner === 'publicProjection')!;
    const version = projection.database.prepare('SELECT contract_version FROM projection_metadata WHERE singleton_id=1').get()?.contract_version;
    if (version === PUBLIC_PROJECTION_CONTRACT_VERSION) {
      assertPublicProjectionSchema(projection.database); auditStoredProjectionState(projection.database);
      assertFixedReceipts(opened);
      return { migrated: false, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, backups: [] };
    }
    if (version !== SOURCE_CONTRACT) throw new Error('communication_migration_source_contract_unsupported');
    validateOldProjection(projection.database);
    // Validate all receipt payloads before the first write or recovery-copy creation.
    visitReceipts(opened, false);
    for (const entry of opened) {
      entry.database.close();
      entry.database = new DatabaseSync(entry.file);
      entry.database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
      const parent = path.join(path.dirname(entry.file), 'migration-backups');
      mkdirSync(parent, { recursive: true });
      entry.backupPath = path.join(parent, `before-fixed-communication.${randomUUID()}.sqlite`);
      entry.database.exec(`VACUUM INTO '${entry.backupPath.replaceAll("'", "''")}';`);
      const descriptor = openSync(entry.backupPath, 'r+');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    for (const entry of opened) entry.database.exec('BEGIN IMMEDIATE;');
    try {
      visitReceipts(opened, true);
      translateProjection(projection.database);
      assertPublicProjectionSchema(projection.database); auditStoredProjectionState(projection.database);
      for (const entry of opened) assertFrozenLayout(entry);
      assertFixedReceipts(opened);
      for (const entry of opened.filter(entry => entry !== projection)) entry.database.exec('COMMIT;');
      projection.database.exec('COMMIT;');
    } catch (error) {
      for (const entry of opened) if (entry.database.isTransaction) entry.database.exec('ROLLBACK;');
      throw error;
    }
    return { migrated: true, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      backups: opened.map(entry => ({ owner: entry.owner, path: entry.backupPath! })) };
  } finally {
    // Attempt all closes even when one resource fails to close; retain its fence via shared helper.
    const failures: unknown[] = [];
    for (const entry of opened.reverse()) {
      try { closeOwnedSqliteDatabase(entry.database, entry.lease); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'communication_migration_close_failed');
  }
}

function assertFrozenLayout(entry: OwnedDatabase): void {
  if (entry.owner === 'productivity' && entry.database.prepare('PRAGMA user_version').get()?.user_version === 3) {
    assertProductivityTaskIsolationSchemaV3(entry.database);
    assertProductivitySqliteIntegrity(entry.database);
    new SqliteProductivityTaskIsolation(entry.database).audit();
    return;
  }
  // A current document store has already crossed the fixed-contract fence.
  // Validate its exact additive layout before the idempotent no-op path.
  if (entry.owner === 'publicProjection'
    && entry.database.prepare('PRAGMA user_version').get()?.user_version === 4
    && entry.database.prepare('SELECT contract_version FROM projection_metadata WHERE singleton_id=1').get()?.contract_version === PUBLIC_PROJECTION_CONTRACT_VERSION) {
    assertPublicProjectionSchema(entry.database);
    return;
  }
  const expected = layout.owners.find(owner => owner.owner === entry.owner)!;
  const schema = entry.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
  if (digest(JSON.stringify(schema)) !== expected.schemaDigest
    || Number(entry.database.prepare('PRAGMA user_version').get()!.user_version) !== expected.schemaMetadataVersion) {
    throw new Error(`communication_migration_layout_mismatch:${entry.owner}`);
  }
  if (entry.database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
    || entry.database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('communication_migration_integrity_failed');
}
function validateOldProjection(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM projection_metadata').all(); const metadata = rows[0];
  const migrations = database.prepare('SELECT * FROM schema_migrations').all(); const migration = migrations[0];
  if (rows.length !== 1 || metadata?.singleton_id !== 1 || metadata.contract_version !== SOURCE_CONTRACT
    || metadata.genesis_digest !== PUBLIC_PROJECTION_GENESIS_DIGEST
    || typeof metadata.stream_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(metadata.stream_id)
    || typeof metadata.created_at !== 'string' || !canonicalTimestamp(metadata.created_at)
    || metadata.metadata_digest !== metadataDigest(SOURCE_CONTRACT, metadata)
    || migrations.length !== 1 || migration?.version !== 3 || migration.name !== 'public_projection_v4_store_v3'
    || migration.applied_at !== metadata.created_at) throw new Error('communication_migration_source_metadata_invalid');
  let cursor = 1; let previous: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  for (const row of commits(database)) {
    const original = JSON.parse(row.commit_json) as Record<string, unknown>;
    const parsed = assertPublicProjectionCommit({ ...original, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION });
    if (row.cursor !== cursor || original.contractVersion !== SOURCE_CONTRACT || row.contract_version !== SOURCE_CONTRACT
      || canonicalPublicProjectionJson({ ...parsed, contractVersion: SOURCE_CONTRACT }) !== row.commit_json
      || row.event_id !== parsed.eventId || row.source_id !== parsed.sourceId || row.source_cursor !== parsed.sourceCursor
      || row.occurred_at !== parsed.occurredAt || row.payload_digest !== digest(row.commit_json)
      || row.history_digest !== historyDigest(previous, cursor, row.payload_digest)) {
      throw new Error('communication_migration_source_history_invalid');
    }
    previous = row.history_digest; cursor++;
  }
}
function translateProjection(database: DatabaseSync): void {
  let previous: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  for (const row of commits(database)) {
    const commit = assertPublicProjectionCommit({ ...JSON.parse(row.commit_json), contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION });
    const json = canonicalPublicProjectionJson(commit); const payload = digest(json);
    const history = historyDigest(previous, row.cursor, payload);
    database.prepare('UPDATE projection_commits SET contract_version=?,commit_json=?,payload_digest=?,history_digest=? WHERE cursor=?')
      .run(PUBLIC_PROJECTION_CONTRACT_VERSION, json, payload, history, row.cursor);
    previous = history;
  }
  const metadata = database.prepare('SELECT * FROM projection_metadata').get()!;
  database.prepare('UPDATE projection_metadata SET contract_version=?,metadata_digest=? WHERE singleton_id=1')
    .run(PUBLIC_PROJECTION_CONTRACT_VERSION, metadataDigest(PUBLIC_PROJECTION_CONTRACT_VERSION, metadata));
  database.prepare('UPDATE schema_migrations SET name=? WHERE version=3').run('public_projection_store');
}
function visitReceipts(entries: OwnedDatabase[], write: boolean, requireFixed = false): void {
  for (const entry of entries) {
    const table = entry.owner === 'productivity' ? 'productivity_commands' : entry.owner === 'longMemory' ? 'long_memory_commands' : null;
    if (table) for (const row of entry.database.prepare(`SELECT command_id,result_json FROM ${table}`).all()) {
      const original = JSON.parse(String(row.result_json)); const result = readPersistedRuntimeResult(original);
      const allowed = entry.owner === 'longMemory' ? ['memory.updated', 'memory.deleted']
        : ['goal.updated', 'todo.snapshot.replaced', 'workflow.updated', 'schedule.updated', 'schedule.occurrence.updated'];
      if (!allowed.includes(result.kind) || (requireFixed && result.kind !== original.kind)) throw new Error('communication_migration_receipt_invalid');
      if (write && result.kind !== original.kind) entry.database.prepare(`UPDATE ${table} SET result_json=? WHERE command_id=?`)
        .run(JSON.stringify({ ...original, kind: result.kind }), row.command_id!);
    }
    if (entry.owner === 'productivity') for (const row of entry.database.prepare('SELECT cursor,kind,event_json FROM productivity_events').all()) {
      const oldKind = String(row.kind);
      const kind = oldKind === 'goal.execution.updated.v3' ? 'goal.execution.updated'
        : oldKind === 'workflow.execution.updated.v3' ? 'workflow.execution.updated' : fixedPersistedCommandKind(oldKind);
      let json = String(row.event_json);
      if (!['goal.execution.updated', 'workflow.execution.updated'].includes(kind)) {
        const original = JSON.parse(json); const result = readPersistedRuntimeResult(original);
        if (requireFixed && original.kind !== result.kind) throw new Error('communication_migration_event_invalid');
        if (original.kind !== result.kind) json = JSON.stringify({ ...original, kind: result.kind });
      }
      if (requireFixed && oldKind !== kind) throw new Error('communication_migration_event_kind_invalid');
      if (write && (oldKind !== kind || json !== row.event_json)) entry.database.prepare('UPDATE productivity_events SET kind=?,event_json=? WHERE cursor=?')
        .run(kind, json, row.cursor!);
    }
  }
}
function assertFixedReceipts(entries: OwnedDatabase[]): void { visitReceipts(entries, false, true); }
function commits(database: DatabaseSync): CommitRow[] { return database.prepare('SELECT * FROM projection_commits ORDER BY cursor').all() as unknown as CommitRow[]; }
function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function historyDigest(previous: string, cursor: number, payload: string): string { return digest(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previous}\u0000${cursor}\u0000${payload}`); }
function metadataDigest(version: string, row: Record<string, unknown>): string { return digest(`${version}\u0000${String(row.stream_id)}\u0000${String(row.genesis_digest)}\u0000${String(row.created_at)}`); }
function canonicalTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
