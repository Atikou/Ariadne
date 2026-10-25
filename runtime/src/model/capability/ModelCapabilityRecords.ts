import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from '../../adapters/persistence/SqliteAuthorityHealth.js';
import { assertQualificationReport, type ModelCapabilityQualification } from './ModelCapabilityQualification.js';

export interface StoredQualificationRow {
  readonly provider_id: string; readonly model_id: string; readonly fingerprint: string;
  readonly adapter_protocol_version: number; readonly tested_at: string | null; readonly report_json: string;
}
export function readStoredQualification(row: StoredQualificationRow): ModelCapabilityQualification {
  return readPersistedAuthorityJson('inference', row.report_json, value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('model_capability_report_invalid');
    const report = assertQualificationReport(value as ModelCapabilityQualification);
    if (report.providerId !== row.provider_id || report.modelId !== row.model_id || report.fingerprint !== row.fingerprint
      || report.adapterProtocolVersion !== row.adapter_protocol_version || (report.testedAt ?? null) !== row.tested_at)
      throw new Error('model_capability_stored_identity_mismatch');
    return Object.freeze({ ...report });
  });
}
/** Proof of the released layout and each original report before version promotion. */
export function auditModelCapabilityAuthority(database: DatabaseSync): void {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all().map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
  if (digest !== 'sha256:4826696fbc1c342810e74bf5620f91fcfcc23da291e727e958c3ac0b7a86b488')
    throw markAuthorityIntegrityError('inference', new Error('model_capability_source_structure_invalid'));
  if (database.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0)
    throw markAuthorityIntegrityError('inference', new Error('model_capability_source_integrity_invalid'));
  for (const row of database.prepare('SELECT * FROM model_capability_qualification ORDER BY provider_id,model_id,fingerprint').iterate())
    readStoredQualification(row as unknown as StoredQualificationRow);
}
