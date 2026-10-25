import { longMemoryContentSchema, longMemoryProvenanceSchema, longMemoryRecordSchema, publicProjectionCanonicalIdSchema, type LongMemoryRecord } from '@ariadne/protocol/public';
import { z } from 'zod';
import { readPersistedRuntimeResult } from '@ariadne/protocol/compatibility';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
export interface LongMemoryRow {
  memory_id: string; scope: LongMemoryRecord['scope']; scope_id: string; workspace_id: string; session_id: string;
  version: number; status: LongMemoryRecord['status'] | 'deleted'; payload_json: string | null;
  reviewed_at: string | null; created_at: string; updated_at: string; retention_until: string | null;
}
const payloadSchema = longMemoryContentSchema.extend({ provenance: longMemoryProvenanceSchema }).strict();
const dateSchema = z.string().datetime({ offset: true });

export function memoryIntegrityFailure(code: string): never {
  throw markAuthorityIntegrityError('memory', new Error(`long_memory_authority_${code}`));
}
export function auditLongMemoryRow(row: LongMemoryRow): LongMemoryRecord | null {
  for (const id of [row.memory_id, row.workspace_id, row.session_id, row.scope_id]) {
    if (!publicProjectionCanonicalIdSchema.safeParse(id).success) memoryIntegrityFailure('identity');
  }
  if (!Number.isSafeInteger(row.version) || row.version < 1 || !['global', 'workspace', 'session'].includes(row.scope)
    || row.scope_id !== (row.scope === 'global' ? 'global' : row.scope === 'workspace' ? row.workspace_id : row.session_id)) memoryIntegrityFailure('scope_binding');
  if (!dateSchema.safeParse(row.created_at).success || !dateSchema.safeParse(row.updated_at).success
    || !dateSchema.nullable().safeParse(row.reviewed_at).success || !dateSchema.nullable().safeParse(row.retention_until).success) memoryIntegrityFailure('timestamp');
  if (Date.parse(row.created_at) > Date.parse(row.updated_at)
    || (row.reviewed_at !== null && Date.parse(row.reviewed_at) > Date.parse(row.updated_at))) memoryIntegrityFailure('clock_binding');
  if (row.status === 'deleted') {
    if (row.payload_json !== null || row.reviewed_at !== null || row.retention_until !== null) memoryIntegrityFailure('tombstone');
    return null;
  }
  if (typeof row.payload_json !== 'string') memoryIntegrityFailure('payload_missing');
  const record = readPersistedAuthorityJson('memory', row.payload_json, value => longMemoryRecordSchema.parse({
    ...payloadSchema.parse(value), memoryId: row.memory_id, version: row.version, scopeId: row.scope_id, status: row.status,
    reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at, expired: false
  }));
  if (record.scope !== row.scope || record.retentionUntil !== row.retention_until
    || (record.status === 'active' && record.reviewedAt === null)
    || (record.status === 'candidate' && record.reviewedAt !== null)) memoryIntegrityFailure('payload_binding');
  return record;
}
export function readLongMemoryVector(text: string, dimension: number): readonly number[] {
  return readPersistedAuthorityJson('memory', text, value => {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65_536 || !Array.isArray(value)
      || value.length !== dimension || !value.every(item => typeof item === 'number' && Number.isFinite(item))) memoryIntegrityFailure('vector');
    return value as number[];
  });
}
export function readLongMemoryReceipt(text: string) {
  return readPersistedAuthorityJson('memory', text, value => {
    const parsed = readPersistedRuntimeResult(value);
    if (parsed.kind !== 'memory.updated' && parsed.kind !== 'memory.deleted') memoryIntegrityFailure('receipt');
    return parsed;
  });
}
