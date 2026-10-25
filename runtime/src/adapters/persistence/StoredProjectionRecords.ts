import { createHash } from 'node:crypto';
import { assertPublicRunDocumentCommit, assertPublicProjectionPayloadSafe,
  canonicalPublicProjectionJson, isRunDocumentChange, publicProjectionChangeSchema, publicProjectionCatalogRow,
  publicRunDocumentChangeSchema, MAX_PUBLIC_PROJECTION_COMMIT_BYTES, RUN_DOCUMENT_COMMIT_VERSION,
  verifyRunDocumentHeaderSteps, PUBLIC_PROJECTION_HISTORY_DOMAIN, type ProjectionCommit, type PublicRunDocumentCommit, type PublicProjectionChange,
  type PublicRunDocumentChange, type PublicProjectionFeature, type PublicProjectionCatalogRow } from '@ariadne/protocol/public';
import { RunDocumentPlan } from '../../projection/RunDocumentPlan.js';
import { assertValidProjectionCommit } from '../../projection/PublicProjectionContract.js';
import { runDocumentCheckSync } from './RunDocumentSqliteVerifier.js';
import { markAuthorityIntegrityError, readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';

export type StoredProjectionCommit = ProjectionCommit | PublicRunDocumentCommit;
export type StoredProjectionChange = PublicProjectionChange | PublicRunDocumentChange;
export function storedProjectionCatalogRow(change: StoredProjectionChange): PublicProjectionCatalogRow {
  return isRunDocumentChange(change) ? { feature: 'runs', dto: change.dto.summary } : publicProjectionCatalogRow(change);
}
export function deriveLegacyRunDocument(change: PublicProjectionChange): RunDocumentPlan {
  if (change.feature !== 'runs' || change.dto === null) throw new Error('run_document_legacy_run_required');
  const summary = publicProjectionCatalogRow(change);
  if (summary.feature !== 'runs') throw new Error('run_document_legacy_run_required');
  return new RunDocumentPlan({ summary: summary.dto, toolActivities: change.dto.toolActivities, inbox: change.dto.inbox,
    interactionMessages: change.dto.interactionMessages.map(message => ({ ...message, runId: message.runId ?? change.aggregateId })) });
}
export interface StoredCommitRow { cursor: number; event_id: string; source_id: string; source_cursor: number;
  contract_version: string; occurred_at: string; commit_json: string; payload_digest: string; history_digest: string }
export interface StoredVersionRow { feature: PublicProjectionFeature; aggregate_id: string; aggregate_version: number;
  operation: 'upsert' | 'delete'; projected_at: string; dto_json: string | null; payload_digest: string;
  commit_cursor: number; change_index: number }
export function projectionDigest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
export function assertStoredCommitHistoryLink(row: StoredCommitRow, previousDigest: string): void {
  const expected = projectionDigest(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previousDigest}\u0000${row.cursor}\u0000${row.payload_digest}`);
  if (row.history_digest !== expected) throw markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:commit:${row.cursor}:history_digest_mismatch`));
}
export function assertStoredProjectionCommit(value: unknown): StoredProjectionCommit {
  const commit = value !== null && typeof value === 'object' && 'contractVersion' in value && value.contractVersion === RUN_DOCUMENT_COMMIT_VERSION
    ? assertPublicRunDocumentCommit(value) : assertValidProjectionCommit(value);
  for (const change of commit.changes) if (isRunDocumentChange(change)) runDocumentCheckSync(verifyRunDocumentHeaderSteps(change.dto));
  return commit;
}
export function parseStoredCommitRow(row: StoredCommitRow): StoredProjectionCommit {
  const commit = readPersistedAuthorityJson('projection', row.commit_json, assertStoredProjectionCommit), json = canonicalPublicProjectionJson(commit);
  assertStoredCommitRowBinding(row, commit, json);
  return commit;
}
/** A canonical, already validated request can prove an identical persisted
 * payload without reparsing it. Every row/header/digest binding still applies. */
export function assertStoredCommitRowBinding(row: StoredCommitRow, commit: StoredProjectionCommit, json: string): void {
  if (!Number.isSafeInteger(row.cursor) || row.cursor <= 0 || row.event_id !== commit.eventId || row.source_id !== commit.sourceId
    || row.source_cursor !== commit.sourceCursor || row.contract_version !== commit.contractVersion || row.occurred_at !== commit.occurredAt
    || row.commit_json !== json || row.payload_digest !== projectionDigest(json) || !/^sha256:[0-9a-f]{64}$/u.test(row.history_digest)) {
    throw markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:commit:${row.cursor}:row_mismatch`));
  }
}
export function assertStoredVersionMatchesChange(row: StoredVersionRow, change: StoredProjectionChange): void {
  if (row.feature !== change.feature || row.aggregate_id !== change.aggregateId || row.aggregate_version !== change.aggregateVersion
    || row.operation !== change.operation || row.projected_at !== change.projectedAt
    || row.dto_json !== (change.dto === null ? null : canonicalPublicProjectionJson(change.dto))
    || row.payload_digest !== projectionDigest(canonicalPublicProjectionJson(change))) {
    throw markAuthorityIntegrityError('projection', new Error(`public_projection_storage_corruption:version:${row.feature}:${row.aggregate_id}:${row.aggregate_version}:row_mismatch`));
  }
}
export function storedVersionRowAsChange(row: StoredVersionRow): StoredProjectionChange {
  const change = readPersistedAuthorityJson('projection', row.dto_json ?? 'null', dto => {
    const value = { feature: row.feature, aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version,
      operation: row.operation, projectedAt: row.projected_at, dto };
    const parsed = isRunDocumentChange(value) ? publicRunDocumentChangeSchema.parse(value) : publicProjectionChangeSchema.parse(value);
    assertPublicProjectionPayloadSafe(parsed);
    if (Buffer.byteLength(canonicalPublicProjectionJson(parsed)) > MAX_PUBLIC_PROJECTION_COMMIT_BYTES) throw new Error('public_projection_storage_corruption:version:payload_too_large');
    if (isRunDocumentChange(parsed)) runDocumentCheckSync(verifyRunDocumentHeaderSteps(parsed.dto));
    return parsed;
  });
  assertStoredVersionMatchesChange(row, change); return change;
}

/** An unacknowledged current-format 5.0 publication may replay after upgrade.
 * Prove the full immutable old DTO derives the exact new root; never rewrite
 * its event, payload, version, cursor or history digest. */
export function storedCommitsEquivalent(existing: StoredProjectionCommit, requested: StoredProjectionCommit): boolean {
  if (canonicalPublicProjectionJson(existing) === canonicalPublicProjectionJson(requested)) return true;
  if (existing.contractVersion === RUN_DOCUMENT_COMMIT_VERSION || requested.contractVersion !== RUN_DOCUMENT_COMMIT_VERSION
    || existing.eventId !== requested.eventId || existing.sourceId !== requested.sourceId || existing.sourceCursor !== requested.sourceCursor
    || existing.occurredAt !== requested.occurredAt || existing.changes.length !== requested.changes.length) return false;
  const old = existing.changes[0], next = requested.changes[0];
  if (old?.feature !== 'runs' || old.dto === null || !isRunDocumentChange(next)) return false;
  const plan = deriveLegacyRunDocument(old);
  if (canonicalPublicProjectionJson({ ...old, dto: plan.header }) !== canonicalPublicProjectionJson(next)) return false;
  return existing.changes.slice(1).every((change, index) => change.feature === 'decisions'
    && canonicalPublicProjectionJson(change) === canonicalPublicProjectionJson(requested.changes[index + 1]));
}
