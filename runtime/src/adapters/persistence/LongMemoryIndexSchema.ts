import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** This is a new disposable index, not a replacement authority Schema. */
export const MEMORY_INDEX_SCHEMA_VERSION=1;
export const MEMORY_INDEX_DDL=[
  "CREATE TABLE memory_index_metadata (memory_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),scope TEXT NOT NULL CHECK(scope IN ('global','workspace','session')),scope_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('candidate','active','inactive','deleted')),reviewed_at TEXT,updated_at TEXT NOT NULL,expires_at INTEGER,memory_type TEXT,importance REAL,confidence REAL,scan_tag TEXT NOT NULL);",
  'CREATE INDEX memory_index_owner_top ON memory_index_metadata(scope,scope_id,status,importance DESC,updated_at DESC,memory_id);',
  'CREATE INDEX memory_index_expiry ON memory_index_metadata(status,expires_at);',
  "CREATE TABLE memory_index_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),space_id TEXT NOT NULL,dimension INTEGER NOT NULL CHECK(dimension BETWEEN 1 AND 65536),scan_tag TEXT NOT NULL,scan_after TEXT,scanning INTEGER NOT NULL CHECK(scanning IN (0,1)),bootstrap_sequence INTEGER NOT NULL,bootstrap_command_id TEXT,cursor_sequence INTEGER NOT NULL,cursor_command_id TEXT);",
  "CREATE TABLE memory_index_jobs (memory_id TEXT PRIMARY KEY REFERENCES memory_index_metadata(memory_id) ON DELETE CASCADE,version INTEGER NOT NULL,space_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('index','expire')),available_at INTEGER NOT NULL,attempts INTEGER NOT NULL CHECK(attempts>=0),leased INTEGER NOT NULL CHECK(leased IN (0,1)));",
  'CREATE INDEX memory_index_job_due ON memory_index_jobs(leased,available_at,memory_id);',
  "CREATE INDEX memory_index_job_failed ON memory_index_jobs(space_id,memory_id,version) WHERE kind='index' AND attempts>0;",
  'CREATE TABLE memory_index_vectors (memory_id TEXT NOT NULL REFERENCES memory_index_metadata(memory_id) ON DELETE CASCADE,version INTEGER NOT NULL,space_id TEXT NOT NULL,dimension INTEGER NOT NULL CHECK(dimension BETWEEN 1 AND 65536),vector_json TEXT NOT NULL CHECK(json_valid(vector_json)),published_at INTEGER NOT NULL,PRIMARY KEY(memory_id,version,space_id));',
  'CREATE INDEX memory_index_vector_space ON memory_index_vectors(space_id,dimension,memory_id,version);',
  'CREATE TABLE memory_index_buckets (memory_id TEXT NOT NULL,version INTEGER NOT NULL,space_id TEXT NOT NULL,table_id INTEGER NOT NULL CHECK(table_id BETWEEN 0 AND 3),bucket INTEGER NOT NULL CHECK(bucket BETWEEN 0 AND 4095),PRIMARY KEY(memory_id,version,space_id,table_id),FOREIGN KEY(memory_id,version,space_id) REFERENCES memory_index_vectors(memory_id,version,space_id) ON DELETE CASCADE);',
  'CREATE INDEX memory_index_bucket_lookup ON memory_index_buckets(space_id,table_id,bucket,memory_id,version);',
  'PRAGMA user_version=1;'
].join('\n');

// Initialized from this new V1 layout, never from or over a released authority baseline.
export const MEMORY_INDEX_LAYOUT_DIGEST='sha256:ef1da253ce969ea83d4fa192e4ed117349cc0ee4fe102e3c88df60256ef3996d';
export function memoryIndexLayoutDigest(database:DatabaseSync):string {
  const rows=database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map(row=>({...row,sql:typeof row.sql==='string'?row.sql.replace(/\s+/gu,' ').trim():null}));
  return 'sha256:'+createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function initializeMemoryIndexSchema(database:DatabaseSync):void {
  const version=Number(database.prepare('PRAGMA user_version').get()?.user_version);
  if(version!==0&&version!==MEMORY_INDEX_SCHEMA_VERSION)throw new Error('long_memory_index_schema_unsupported');
  if(version===0&&database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
    throw new Error('long_memory_index_unversioned_file_preserved');
  database.exec('PRAGMA foreign_keys=ON;');
  if(version===0){
    database.exec('BEGIN IMMEDIATE;');
    try{database.exec(MEMORY_INDEX_DDL);auditMemoryIndexLayout(database);database.exec('COMMIT;');}
    catch(error){if(database.isTransaction)database.exec('ROLLBACK;');throw error;}
  }else auditMemoryIndexLayout(database);
}
function auditMemoryIndexLayout(database:DatabaseSync):void {
  if(memoryIndexLayoutDigest(database)!==MEMORY_INDEX_LAYOUT_DIGEST
    ||database.prepare('PRAGMA integrity_check').all().some(row=>row.integrity_check!=='ok')
    ||database.prepare('PRAGMA foreign_key_check').all().length)throw new Error('long_memory_index_layout_or_integrity_invalid');
}
