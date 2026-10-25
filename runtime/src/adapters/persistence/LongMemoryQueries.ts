import type { DatabaseSync } from 'node:sqlite';
import { type LongMemoryCommand, type LongMemoryRecord, type LongMemoryResult } from '@ariadne/protocol/public';
import { auditLongMemoryRow, memoryIntegrityFailure, type LongMemoryRow } from './LongMemoryRecords.js';
export type { LongMemoryRow } from './LongMemoryRecords.js';

export type MemoryOwnerScope = { readonly workspaceId: string; readonly sessionId: string };
export const memoryOwnerPredicate = `(m.scope='global' OR (m.scope='workspace' AND m.scope_id=?)
  OR (m.scope='session' AND m.scope_id=? AND m.workspace_id=?))`;
export const memoryOwnerParameters = (scope: MemoryOwnerScope): readonly string[] => [scope.workspaceId, scope.sessionId, scope.workspaceId];
export function projectLongMemory(row: LongMemoryRow, now: string): LongMemoryRecord {
  const record = auditLongMemoryRow(row);
  if (record === null) memoryIntegrityFailure('deleted_payload');
  return { ...record, expired: row.retention_until !== null && Date.parse(row.retention_until) <= Date.parse(now) };
}
export function readLongMemoryRow(database: DatabaseSync, memoryId: string, owner: MemoryOwnerScope): LongMemoryRow | undefined {
  const row = database.prepare(`SELECT m.* FROM long_memories m WHERE m.memory_id=? AND m.status<>'deleted' AND ${memoryOwnerPredicate}`)
    .get(memoryId, ...memoryOwnerParameters(owner)) as unknown as LongMemoryRow | undefined;
  if (row) auditLongMemoryRow(row); return row;
}
export function queryLongMemories(database: DatabaseSync, command: Extract<LongMemoryCommand, { kind: 'memory.query' }>, now: string):
  Extract<LongMemoryResult, { kind: 'memory.query_result' }> {
  const before = command.before;
  const rows = database.prepare(`SELECT m.* FROM long_memories m WHERE m.status<>'deleted' AND ${memoryOwnerPredicate}
    AND (? IS NULL OR m.scope=?) AND (?='all' OR m.status=?)
    AND (? IS NULL OR julianday(m.updated_at)<julianday(?) OR (julianday(m.updated_at)=julianday(?) AND m.memory_id<?))
    ORDER BY julianday(m.updated_at) DESC,m.memory_id DESC LIMIT ?`)
    .all(...memoryOwnerParameters(command), command.scope, command.scope, command.status, command.status,
      before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.memoryId ?? null, command.limit + 1) as unknown as LongMemoryRow[];
  const memories = rows.slice(0, command.limit).map(row => projectLongMemory(row, now)); const last = memories.at(-1);
  return { kind: 'memory.query_result', memories, nextCursor: rows.length > command.limit && last
    ? { updatedAt: last.updatedAt, memoryId: last.memoryId } : null };
}

/** FTS tokenization retains Chinese word fragments and quotes every term before MATCH. */
export function memoryLexicalTerms(input: string): readonly string[] {
  const terms = new Set<string>();
  for (const word of input.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    terms.add(word);
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let index = 0; index < chars.length - 1; index++) terms.add(chars.slice(index, index + 2).join(''));
    }
  }
  return [...terms];
}
export function memoryFtsText(input: string): string { return memoryLexicalTerms(input).join(' '); }
export function lexicalMemorySearch(database: DatabaseSync, owner: MemoryOwnerScope, query: string, limit: number, now: string):
  readonly { readonly memory: LongMemoryRecord; readonly rank: number }[] {
  const terms = memoryLexicalTerms(query).slice(0, 32);
  if (terms.length === 0) return [];
  const match = terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' OR ');
  const rows = database.prepare(`SELECT m.*,bm25(long_memory_fts,0,3,1) AS rank FROM long_memory_fts
    JOIN long_memories m ON m.memory_id=long_memory_fts.memory_id
    WHERE long_memory_fts MATCH ? AND ${memoryOwnerPredicate} AND m.status='active' AND m.reviewed_at IS NOT NULL
    AND (m.retention_until IS NULL OR julianday(m.retention_until)>julianday(?))
    ORDER BY rank,m.memory_id LIMIT ?`).all(match, ...memoryOwnerParameters(owner), now, limit) as unknown as (LongMemoryRow & { rank: number })[];
  return rows.map(row => ({ memory: projectLongMemory(row, now), rank: row.rank }));
}
