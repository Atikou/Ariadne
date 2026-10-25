import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { longMemoryContentSchema, longMemoryProvenanceSchema,
  type LongMemoryCommand, type LongMemoryContent, type LongMemoryProvenance, type LongMemoryRecord, type LongMemoryResult } from '@ariadne/protocol/public';
import { initializeLongMemorySchema } from './LongMemoryDbSchema.js';
import { SqliteLongMemoryIndexStore } from './SqliteLongMemoryIndexStore.js';
import { DATABASE_PATHS } from './DatabasePaths.js';
import { commandReceiptIdentity } from './CommandReceiptIdentity.js';
import { auditLongMemoryRow, readLongMemoryReceipt } from './LongMemoryRecords.js';
import { memoryIndexMetadataSchema,type MemoryIndexMetadata,type MemoryIndexCursor,type MemoryIndexChangePage } from './LongMemoryIndexRecords.js';
import { markAuthorityIntegrityError } from './SqliteAuthorityHealth.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { SqliteTransactionOwner, type SqliteTransactionShutdownContext } from './SqliteTransactionOwner.js';
import { queryLongMemories, readLongMemoryRow, projectLongMemory,
  memoryFtsText, lexicalMemorySearch, type MemoryOwnerScope, type LongMemoryRow } from './LongMemoryQueries.js';
export { LONG_MEMORY_DB_SCHEMA_VERSION } from './LongMemoryDbSchema.js';

type Mutation = Extract<LongMemoryCommand, { kind: 'memory.put' | 'memory.transition' | 'memory.delete' }>;
type Receipt = Extract<LongMemoryResult, { kind: 'memory.updated' | 'memory.deleted' }>;
const scopeId = (input: MemoryOwnerScope, scope: LongMemoryContent['scope']) => scope === 'global' ? 'global' : scope === 'workspace' ? input.workspaceId : input.sessionId;
const timestamp = (now: Date) => { if (!Number.isFinite(now.getTime())) throw new Error('long_memory_clock_invalid'); return now.toISOString(); };
const indexMetadataSelect=[
  'SELECT memory_id AS memoryId,version,scope,scope_id AS scopeId,workspace_id AS workspaceId,session_id AS sessionId,',
  'status,reviewed_at AS reviewedAt,updated_at AS updatedAt,retention_until AS retentionUntil,',
  "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.memoryType') ELSE NULL END AS memoryType,",
  "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.importance') ELSE NULL END AS importance,",
  "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.confidence') ELSE NULL END AS confidence FROM long_memories"
].join(' ');
function indexMetadata(row:unknown):MemoryIndexMetadata {
  const parsed=memoryIndexMetadataSchema.safeParse(row);
  if(!parsed.success)throw markAuthorityIntegrityError('memory',new Error('long_memory_index_source_metadata_invalid'));
  return parsed.data;
}

/** One authority owns CAS, scoped reads, forget tombstones, FTS. */
export class SqliteLongMemoryStore {
  private readonly database: DatabaseSync;
  private readonly owner: SqliteTransactionOwner;
  public assertHealthy(): void { this.owner.assertHealthy(); }

  public constructor(private readonly dataRoot: string) {
    const databasePath = path.resolve(dataRoot, DATABASE_PATHS.longMemory);
    mkdirSync(path.dirname(databasePath), { recursive: true }); const lease = acquireSqliteOwnerLease(databasePath, 'long-memory');
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath); database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
      initializeLongMemorySchema(database); database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); this.database = database;
      this.owner = new SqliteTransactionOwner(database, databasePath, lease, {
        source: 'memory',
        shutdownRequestedCode: 'long_memory_shutdown_requested', closedCode: 'long_memory_store_closed',
        shutdownConflictCode: 'long_memory_shutdown_context_conflict', transactionActiveCode: 'long_memory_transaction_active',
        shutdownDeadlineCode: 'long_memory_shutdown_deadline_exceeded'
      });
    } catch (error) {
      try { if (database === null) lease.close(); else closeOwnedSqliteDatabase(database, lease); }
      catch (closeError) { throw new AggregateError([error, closeError], 'long_memory_open_cleanup_failed'); } throw error;
    }
  }
  public openSearchIndex(): SqliteLongMemoryIndexStore { return new SqliteLongMemoryIndexStore(this.dataRoot); }
  public execute(commandId: string, command: Mutation, now = new Date(), signal?: AbortSignal): Promise<Receipt> {
    return this.write(commandId, command, now, () => this.mutate(command, timestamp(now)), signal);
  }
  public stageCandidate(commandId: string, input: MemoryOwnerScope & LongMemoryContent & { readonly memoryId: string; readonly runId: string }, now = new Date(), signal?: AbortSignal): Promise<Receipt> {
    if (input.scope === 'global') return Promise.reject(new Error('long_memory_agent_global_write_denied'));
    const content = longMemoryContentSchema.parse(inputContent(input));
    const provenance = longMemoryProvenanceSchema.parse({ kind: 'agent', runId: input.runId });
    return this.write(commandId, { kind: 'long_memory.stage_candidate', ...input }, now,
      () => this.put(input, input.memoryId, null, content, provenance, 'candidate', null, timestamp(now)), signal);
  }
  public reconcile(commandId: string, command: Mutation): Promise<Receipt | null> {
    const identity = commandReceiptIdentity(command);
    return this.read(() => this.readReceipt(commandId, identity.fingerprint, identity.previousFingerprints));
  }
  public query(command: Extract<LongMemoryCommand, { kind: 'memory.query' }>, now = new Date()): Promise<Extract<LongMemoryResult, { kind: 'memory.query_result' }>> {
    return this.read(() => queryLongMemories(this.database, command, timestamp(now)));
  }
  public get(memoryId: string, scope: MemoryOwnerScope, now = new Date()): Promise<LongMemoryRecord | null> {
    return this.read(() => { const row = readLongMemoryRow(this.database, memoryId, scope); return row ? projectLongMemory(row, timestamp(now)) : null; });
  }
  public lexicalSearch(scope: MemoryOwnerScope, query: string, limit: number, now = new Date()) {
    return this.read(() => lexicalMemorySearch(this.database, scope, query, limit, timestamp(now)));
  }
  /** Existing same-transaction receipts provide durable index changes.
   * Position is fenced by immutable command identity; a restore or VACUUM
   * requires background metadata rescan, never mutation replay. */
  public indexChanges(cursor:MemoryIndexCursor,limit=128):Promise<MemoryIndexChangePage> {
    if(!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||!Number.isSafeInteger(limit)||limit<1||limit>256)
      return Promise.reject(new Error('long_memory_index_cursor_invalid'));
    return this.read(()=>{
      const last=this.database.prepare('SELECT rowid AS sequence,command_id FROM long_memory_commands ORDER BY rowid DESC LIMIT 1').get() as {sequence:number;command_id:string}|undefined;
      const head:MemoryIndexCursor={sequence:last?.sequence??0,commandId:last?.command_id??null};
      const fence=cursor.sequence===0?null:this.database.prepare('SELECT command_id FROM long_memory_commands WHERE rowid=?').get(cursor.sequence);
      const resetRequired=cursor.sequence===0?cursor.commandId!==null:fence?.command_id!==cursor.commandId;
      if(resetRequired)return {resetRequired:true,head,changes:[]};
      const changes=this.database.prepare('SELECT rowid AS sequence,command_id,result_json FROM long_memory_commands WHERE rowid>? ORDER BY rowid LIMIT ?')
        .all(cursor.sequence,limit).map(row=>{
          const receipt=readLongMemoryReceipt(String(row.result_json));
          return {sequence:Number(row.sequence),commandId:String(row.command_id),memoryId:receipt.memoryId,version:receipt.version};
        });
      return {resetRequired:false,head,changes};
    });
  }
  /** Keyset metadata only, for bounded background bootstrap. Foreground recall
   * must not use this method to build missing vectors. */
  public indexMetadataPage(after:string|null,limit=256):Promise<readonly MemoryIndexMetadata[]> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>256)return Promise.reject(new Error('long_memory_index_page_invalid'));
    return this.read(()=>this.database.prepare(indexMetadataSelect+' WHERE (? IS NULL OR memory_id>?) ORDER BY memory_id LIMIT ?')
      .all(after,after,limit).map(indexMetadata));
  }
  public indexMetadataFor(memoryIds:readonly string[]):Promise<readonly MemoryIndexMetadata[]> {
    if(memoryIds.length>256)return Promise.reject(new Error('long_memory_index_page_invalid'));
    const ids=[...new Set(memoryIds)];if(!ids.length)return Promise.resolve([]);
    return this.read(()=>{
      const rows=this.database.prepare(indexMetadataSelect+' WHERE memory_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY memory_id')
        .all(...ids).map(indexMetadata);
      if(rows.length!==ids.length)throw markAuthorityIntegrityError('memory',new Error('long_memory_index_receipt_source_missing'));
      return rows;
    });
  }
  public indexSource(memoryId:string,version:number,now=new Date()):Promise<LongMemoryRecord|null> {
    return this.read(()=>{
      const row=this.database.prepare("SELECT * FROM long_memories WHERE memory_id=? AND version=? AND status='active' AND reviewed_at IS NOT NULL")
        .get(memoryId,version) as unknown as LongMemoryRow|undefined;
      if(!row)return null;const memory=projectLongMemory(row,timestamp(now));return memory.expired?null:memory;
    });
  }
  /** Publish derived bytes synchronously while this authority read transaction
   * and its owner queue fence the source version. No source content is written. */
  public publishIndexIfCurrent(memoryId:string,version:number,now:Date,publish:()=>boolean):Promise<boolean> {
    return this.read(()=>{
      const row=this.database.prepare("SELECT * FROM long_memories WHERE memory_id=? AND version=? AND status='active' AND reviewed_at IS NOT NULL")
        .get(memoryId,version) as unknown as LongMemoryRow|undefined;
      if(!row||projectLongMemory(row,timestamp(now)).expired)return false;
      const result=publish();if(typeof result!=='boolean')throw new Error('long_memory_index_publication_must_be_synchronous');
      return result;
    });
  }
  public prepareShutdown(context: SqliteTransactionShutdownContext): void { this.owner.prepareShutdown(context); }
  public close(context: SqliteTransactionShutdownContext): Promise<void> { return this.owner.close(context); }
  private read<T>(operation: () => T): Promise<T> { return this.owner.schedule(signal => this.owner.transaction('read', operation, signal)); }
  private write(commandId: string, command: unknown, now: Date, operation: () => Receipt, requestSignal?: AbortSignal): Promise<Receipt> {
    return this.owner.schedule(ownerSignal => this.owner.transaction('write', () => {
      const { fingerprint, previousFingerprints } = commandReceiptIdentity(command);
      const cached = this.readReceipt(commandId, fingerprint, previousFingerprints); if (cached) return cached;
      const result = operation(); this.database.prepare('INSERT INTO long_memory_commands VALUES (?,?,?,?)').run(commandId, fingerprint, JSON.stringify(result), timestamp(now)); return result;
    }, requestSignal ? AbortSignal.any([ownerSignal, requestSignal]) : ownerSignal));
  }
  private readReceipt(commandId: string, fingerprint: string, previousFingerprints: readonly string[] = []): Receipt | null {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM long_memory_commands WHERE command_id=?').get(commandId) as { fingerprint: string; result_json: string } | undefined;
    if (!row) return null; if (row.fingerprint !== fingerprint && !previousFingerprints.includes(row.fingerprint)) throw new Error('long_memory_command_conflict');
    return readLongMemoryReceipt(row.result_json);
  }
  private mutate(command: Mutation, now: string): Receipt {
    if (command.kind === 'memory.put') return this.put(command, command.memoryId, command.expectedVersion,
      longMemoryContentSchema.parse(inputContent(command)), { kind: 'user' }, 'active', now, now);
    const row = this.existing(command.memoryId, command, command.expectedVersion);
    const nextVersion = advance(row.version); if (Date.parse(now) < Date.parse(row.updated_at)) throw new Error('long_memory_clock_regressed');
    if (command.kind === 'memory.delete') {
      this.removeIndex(row.memory_id);
      this.database.prepare("UPDATE long_memories SET version=?,status='deleted',payload_json=NULL,reviewed_at=NULL,retention_until=NULL,updated_at=? WHERE memory_id=?")
        .run(nextVersion, now, row.memory_id); return { kind: 'memory.deleted', memoryId: row.memory_id, version: nextVersion };
    }
    this.removeIndex(row.memory_id); const status = command.action === 'activate' ? 'active' : 'inactive';
    this.database.prepare('UPDATE long_memories SET version=?,status=?,reviewed_at=?,updated_at=? WHERE memory_id=?')
      .run(nextVersion, status, now, now, row.memory_id);
    if (status === 'active') this.index(row.memory_id, projectLongMemory(row, now));
    return { kind: 'memory.updated', memoryId: row.memory_id, version: nextVersion };
  }
  private put(owner: MemoryOwnerScope, memoryId: string, expectedVersion: number | null, content: LongMemoryContent,
    provenance: LongMemoryProvenance, status: LongMemoryRecord['status'], reviewedAt: string | null, now: string): Receipt {
    const raw = this.database.prepare('SELECT * FROM long_memories WHERE memory_id=?').get(memoryId) as unknown as LongMemoryRow | undefined;
    if (raw) auditLongMemoryRow(raw);
    if (raw && (!readLongMemoryRow(this.database, memoryId, owner) || raw.scope !== content.scope || raw.scope_id !== scopeId(owner, content.scope))) throw new Error('long_memory_scope_conflict');
    if ((raw?.version ?? null) !== expectedVersion) throw new Error('long_memory_version_conflict');
    if (raw && Date.parse(now) < Date.parse(raw.updated_at)) throw new Error('long_memory_clock_regressed');
    const version = advance(raw?.version ?? 0);
    const nextStatus = raw?.status ?? status;
    const nextReviewedAt = nextStatus === 'active' ? reviewedAt : raw?.reviewed_at ?? null;
    this.removeIndex(memoryId);
    const payload = { ...content, provenance };
    this.database.prepare(`INSERT INTO long_memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET
      version=excluded.version,status=excluded.status,payload_json=excluded.payload_json,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at,retention_until=excluded.retention_until`)
      .run(memoryId, content.scope, scopeId(owner, content.scope), owner.workspaceId, owner.sessionId, version, nextStatus, JSON.stringify(payload), nextReviewedAt, raw?.created_at ?? now, now, content.retentionUntil);
    if (nextStatus === 'active') this.index(memoryId, content);
    return { kind: 'memory.updated', memoryId, version };
  }
  private existing(memoryId: string, owner: MemoryOwnerScope, expectedVersion: number): LongMemoryRow {
    const row = readLongMemoryRow(this.database, memoryId, owner); if (!row) throw new Error('long_memory_not_found');
    if (row.version !== expectedVersion) throw new Error('long_memory_version_conflict'); return row;
  }
  private index(memoryId: string, content: LongMemoryContent): void { this.database.prepare('INSERT INTO long_memory_fts VALUES (?,?,?)').run(memoryId, memoryFtsText(content.title), memoryFtsText(content.content)); }
  private removeIndex(memoryId: string): void { this.database.prepare('DELETE FROM long_memory_fts WHERE memory_id=?').run(memoryId); this.database.prepare('DELETE FROM long_memory_vectors WHERE memory_id=?').run(memoryId); }
}
function advance(version: number): number { if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) throw new Error('long_memory_version_exhausted'); return version + 1; }
function inputContent(value: LongMemoryContent): LongMemoryContent {
  return { scope: value.scope, memoryType: value.memoryType, title: value.title, content: value.content,
    importance: value.importance, confidence: value.confidence, sensitivity: value.sensitivity, retentionUntil: value.retentionUntil };
}
