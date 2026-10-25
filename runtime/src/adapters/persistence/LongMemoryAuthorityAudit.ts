import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { auditLongMemoryRow, memoryIntegrityFailure, readLongMemoryReceipt, readLongMemoryVector } from './LongMemoryRecords.js';
import { memoryFtsText, type LongMemoryRow } from './LongMemoryQueries.js';

/** Read-only proof of the released layout and original authority bytes.
 * Derived FTS/vector inconsistencies are rejected, never silently rebuilt. */
export function auditLongMemoryAuthority(database: DatabaseSync): void {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all().map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
  if (digest !== 'sha256:de856016ed2a41dcce678fa63fd72c4c101007327fbcd70b2eebaf84f4ed9058') memoryIntegrityFailure('layout');
  if (database.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0) memoryIntegrityFailure('sqlite_integrity');
  for (const item of database.prepare('SELECT * FROM long_memories ORDER BY memory_id').iterate()) {
    const row = item as unknown as LongMemoryRow; const memory = auditLongMemoryRow(row);
    const indexed = database.prepare('SELECT title,content FROM long_memory_fts WHERE memory_id=?').all(row.memory_id);
    if (memory?.status === 'active') {
      if (indexed.length !== 1 || indexed[0]!.title !== memoryFtsText(memory.title)
        || indexed[0]!.content !== memoryFtsText(memory.content)) memoryIntegrityFailure('fts_binding');
    } else if (indexed.length !== 0) memoryIntegrityFailure('fts_binding');
  }
  if (database.prepare('SELECT 1 FROM long_memory_fts f LEFT JOIN long_memories m ON m.memory_id=f.memory_id WHERE m.memory_id IS NULL LIMIT 1').get())
    memoryIntegrityFailure('fts_orphan');
  for (const row of database.prepare('SELECT * FROM long_memory_vectors ORDER BY memory_id').iterate()) {
    const memory = database.prepare('SELECT version,status,reviewed_at FROM long_memories WHERE memory_id=?').get(row.memory_id!);
    if (!memory || memory.version !== row.memory_version || memory.status !== 'active' || memory.reviewed_at === null
      || typeof row.space_id !== 'string' || row.space_id.length === 0 || typeof row.vector_json !== 'string') memoryIntegrityFailure('vector_binding');
    readLongMemoryVector(row.vector_json, Number(row.dimension));
  }
  for (const row of database.prepare('SELECT * FROM long_memory_commands ORDER BY command_id').iterate()) {
    if (typeof row.command_id !== 'string' || row.command_id.length === 0 || typeof row.fingerprint !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(row.fingerprint) || typeof row.result_json !== 'string'
      || typeof row.committed_at !== 'string' || !Number.isFinite(Date.parse(row.committed_at))) memoryIntegrityFailure('receipt_binding');
    const receipt = readLongMemoryReceipt(row.result_json);
    const memory = database.prepare('SELECT version FROM long_memories WHERE memory_id=?').get(receipt.memoryId);
    if (!memory || Number(memory.version) < receipt.version) memoryIntegrityFailure('receipt_version');
  }
}
