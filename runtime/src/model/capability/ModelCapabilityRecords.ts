import type { DatabaseSync } from 'node:sqlite';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from '../../adapters/persistence/SqliteAuthorityHealth.js';
import { assertQualificationReport, type ModelCapabilityQualification } from './ModelCapabilityQualification.js';
import { MODEL_CAPABILITY_TABLES } from './ModelCapabilityDbSchema.js';

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
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const expected = Object.entries(MODEL_CAPABILITY_TABLES);
  // Compare the DDL tokens, not formatting retained by sqlite_master. Released
  // metadata-1 databases used spaces around CHECK/PRIMARY KEY punctuation.
  // Exact object and token matching still rejects altered constraints or SQL.
  if (schema.length !== expected.length || expected.some(([name, sql], index) => {
    const actual = schema[index]!;
    return actual.type !== 'table' || actual.name !== name || actual.tbl_name !== name
      || typeof actual.sql !== 'string' || ddlTokens(actual.sql) !== ddlTokens(sql);
  }))
    throw markAuthorityIntegrityError('inference', new Error('model_capability_source_structure_invalid'));
  if (database.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0)
    throw markAuthorityIntegrityError('inference', new Error('model_capability_source_integrity_invalid'));
  for (const row of database.prepare('SELECT * FROM model_capability_qualification ORDER BY provider_id,model_id,fingerprint').iterate())
    readStoredQualification(row as unknown as StoredQualificationRow);
}

/** These owned declarations contain only unquoted identifiers, numbers and punctuation. */
function ddlTokens(sql: string): string {
  return JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/gu)?.map(token => token.toLowerCase()));
}
