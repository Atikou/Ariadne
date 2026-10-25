import { z } from 'zod';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, PUBLIC_PROJECTION_HISTORY_DOMAIN,
  assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson,
  publicProjectionCanonicalIdSchema, publicProjectionCanonicalTimestampSchema, publicProjectionDigestSchema,
  publicProjectionChangeSchema, publicSessionProjectionSchema, publicRunProjectionSchema,
  publicDecisionProjectionSchema, type PublicProjectionChange } from './projection.js';
import { MAX_PUBLIC_PROJECTION_PAGE_BYTES, MAX_PUBLIC_PROJECTION_PAGE_ROWS,
  publicProjectionScopeSchema, publicProjectionScopeFeatures, publicProjectionSnapshotManifestSchema } from './projection-pages.js';

export const PUBLIC_PROJECTION_CATALOG_VERSION = '3.0' as const;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const feature = z.enum(['sessions', 'runs', 'decisions']);
const filter = z.enum(['all', 'active', 'archived', 'pending']);
const continuation = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u);
const selection = { scope: publicProjectionScopeSchema, feature, filter };
const count = cursor.optional();
const statusCountsSchema = z.object({ active: count, archived: count, pending: count, approved: count,
  rejected: count, expired: count, queued: count, running: count, waiting_permission: count,
  waiting_decision: count, waiting_budget: count, waiting_children: count, cancelling: count,
  paused: count, completed: count, failed: count, cancelled: count, interrupted: count }).strict();
const decisionKindCountsSchema = z.object({ permission: count, plan: count, recovery: count, budget: count, user_question: count }).strict();
function checkSelection(value: { scope: z.infer<typeof publicProjectionScopeSchema>; feature: z.infer<typeof feature>;
  filter: z.infer<typeof filter> }, context: z.RefinementCtx) {
  if (!publicProjectionScopeFeatures(value.scope).includes(value.feature)
    || (value.filter === 'archived' && value.feature !== 'sessions')
    || (value.filter === 'pending' && value.feature !== 'decisions')
    || (value.filter === 'active' && value.feature === 'decisions')) {
    context.addIssue({ code: 'custom', message: 'Catalog selection escaped its scope or status domain.' });
  }
}
export const publicProjectionCatalogBeginRequestSchema = z.object({
  pageContractVersion: z.string().min(1).max(32), ...selection
}).strict().superRefine(checkSelection);
export type PublicProjectionCatalogBeginRequest = z.infer<typeof publicProjectionCatalogBeginRequestSchema>;
export const publicProjectionCatalogManifestSchema = z.object({ ...publicProjectionSnapshotManifestSchema.shape,
  pageContractVersion: z.literal(PUBLIC_PROJECTION_CATALOG_VERSION), feature, filter
}).strict().superRefine((value, context) => {
  checkSelection(value, context);
  const { feature: _feature, filter: _filter, ...base } = value;
  if (!publicProjectionSnapshotManifestSchema.safeParse({ ...base, pageContractVersion: '1.0' }).success) {
    context.addIssue({ code: 'custom', message: 'Catalog boundary or expiry is invalid.' });
  }
});
export type PublicProjectionCatalogManifest = z.infer<typeof publicProjectionCatalogManifestSchema>;

const { toolActivities: _tools, inbox: _inbox, interactionMessages: _messages, ...runFields } = publicRunProjectionSchema.shape;
export const publicRunCatalogSummarySchema = z.object({ ...runFields,
  toolActivityCount: cursor, queuedInputCount: cursor, claimedInputCount: cursor, interactionMessageCount: cursor
}).strict().superRefine((value, context) => {
  if ((value.parentRunId === undefined) !== (value.delegationId === undefined)
    || (value.parentRunId === undefined) !== (value.subagentMode === undefined)
    || (value.parentRunId === undefined) !== (value.subagentProviderId === undefined)
    || (value.startedAt !== undefined && value.updatedAt < value.startedAt)
    || (value.startedAt !== undefined && value.completedAt !== undefined && value.completedAt < value.startedAt)) {
    context.addIssue({ code: 'custom', message: 'Run summary identity or temporal ordering is invalid.' });
  }
});
export type PublicRunCatalogSummary = z.infer<typeof publicRunCatalogSummarySchema>;
export const publicDecisionCatalogSummarySchema = z.object({
  decisionId: publicProjectionCanonicalIdSchema, runId: publicProjectionCanonicalIdSchema,
  sessionId: publicProjectionCanonicalIdSchema, version: publicDecisionProjectionSchema.shape.version,
  kind: publicDecisionProjectionSchema.shape.kind, status: publicDecisionProjectionSchema.shape.status,
  title: z.string().trim().min(1).max(256), requestedAt: publicProjectionCanonicalTimestampSchema,
  resolvedAt: publicProjectionCanonicalTimestampSchema.optional()
}).strict().superRefine((value, context) => {
  if ((value.resolvedAt !== undefined && value.resolvedAt < value.requestedAt)
    || (value.status === 'pending' && value.resolvedAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Decision summary settlement is invalid.' });
  }
});
export type PublicDecisionCatalogSummary = z.infer<typeof publicDecisionCatalogSummarySchema>;
export const publicProjectionCatalogRowSchema = z.discriminatedUnion('feature', [
  z.object({ feature: z.literal('sessions'), dto: publicSessionProjectionSchema }).strict(),
  z.object({ feature: z.literal('runs'), dto: publicRunCatalogSummarySchema }).strict(),
  z.object({ feature: z.literal('decisions'), dto: publicDecisionCatalogSummarySchema }).strict()
]);
export type PublicProjectionCatalogRow = z.infer<typeof publicProjectionCatalogRowSchema>;
export function publicProjectionCatalogRow(change: PublicProjectionChange): PublicProjectionCatalogRow {
  if (change.operation !== 'upsert' || change.dto === null) throw new Error('projection_catalog_upsert_required');
  switch (change.feature) {
    case 'sessions': return { feature: 'sessions', dto: change.dto };
    case 'runs': {
      const { toolActivities, inbox, interactionMessages, ...metadata } = change.dto;
      return { feature: 'runs', dto: { ...metadata, toolActivityCount: toolActivities.length,
        queuedInputCount: inbox.filter(input => input.state === 'queued').length,
        claimedInputCount: inbox.filter(input => input.state === 'claimed').length,
        interactionMessageCount: interactionMessages.length } };
    }
    case 'decisions': {
      const { decisionId, runId, sessionId, version, kind, status, requestedAt, resolvedAt, presentation } = change.dto;
      return { feature: 'decisions', dto: { decisionId, runId, sessionId, version, kind, status,
        requestedAt, ...(resolvedAt === undefined ? {} : { resolvedAt }), title: presentation.headline } };
    }
    default: throw new Error('projection_catalog_feature_invalid');
  }
}
export function catalogRowKey(row: PublicProjectionCatalogRow): { rank: number; at: string; id: string } {
  switch (row.feature) {
    case 'sessions': return { rank: row.dto.pinned ? 0 : 1, at: row.dto.updatedAt, id: row.dto.sessionId };
    case 'runs': return { rank: ['completed', 'failed', 'cancelled', 'interrupted'].includes(row.dto.status) ? 1 : 0,
      at: row.dto.updatedAt, id: row.dto.runId };
    case 'decisions': return { rank: row.dto.status === 'pending' ? 0 : 1, at: row.dto.requestedAt, id: row.dto.decisionId };
  }
}
export function compareCatalogRows(left: PublicProjectionCatalogRow, right: PublicProjectionCatalogRow): number {
  const a = catalogRowKey(left), b = catalogRowKey(right);
  return a.rank - b.rank || (a.at === b.at ? 0 : a.at > b.at ? -1 : 1)
    || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
}
export function catalogRowMatches(row: PublicProjectionCatalogRow, manifest: PublicProjectionCatalogManifest): boolean {
  if (row.feature !== manifest.feature) return false;
  if (manifest.scope.kind === 'session' && ('sessionId' in row.dto && row.dto.sessionId !== manifest.scope.sessionId)) return false;
  if (manifest.scope.kind === 'directory' && manifest.scope.workspaceId !== undefined && row.feature === 'sessions'
    && row.dto.workspaceId !== manifest.scope.workspaceId) return false;
  if (manifest.filter === 'all') return true;
  if (manifest.filter === 'active' && row.feature === 'runs') return catalogRowKey(row).rank === 0;
  return row.dto.status === manifest.filter;
}

export const publicProjectionCatalogResetSchema = z.object({ status: z.literal('reset_required'),
  streamId: publicProjectionCanonicalIdSchema, reason: z.enum(['contract_mismatch', 'stream_mismatch', 'scope_mismatch',
    'snapshot_expired', 'boundary_mismatch', 'page_cursor_invalid', 'history_unavailable', 'cursor_gap', 'history_mismatch']) }).strict();
export type PublicProjectionCatalogReset = z.infer<typeof publicProjectionCatalogResetSchema>;
export const publicProjectionCatalogPageRequestSchema = z.object({ manifest: publicProjectionCatalogManifestSchema,
  limit: z.number().int().min(1).max(MAX_PUBLIC_PROJECTION_PAGE_ROWS), pageCursor: continuation.optional() }).strict();
export type PublicProjectionCatalogPageRequest = z.infer<typeof publicProjectionCatalogPageRequestSchema>;
export const publicProjectionCatalogPageSchema = z.object({ status: z.literal('ok'), manifest: publicProjectionCatalogManifestSchema,
  pageIndex: cursor, previousPageDigest: publicProjectionDigestSchema, pageDigest: publicProjectionDigestSchema,
  totalRows: cursor, statusCounts: statusCountsSchema, decisionKindCounts: decisionKindCountsSchema,
  rows: z.array(publicProjectionCatalogRowSchema).max(MAX_PUBLIC_PROJECTION_PAGE_ROWS), hasMore: z.boolean(), nextPageCursor: continuation.optional()
}).strict().superRefine((value, context) => {
  const statuses = value.manifest.feature === 'sessions' ? publicSessionProjectionSchema.shape.status.options
    : value.manifest.feature === 'runs' ? publicRunProjectionSchema.shape.status.options : publicDecisionProjectionSchema.shape.status.options;
  if ((value.pageIndex === 0) !== (value.previousPageDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)
    || value.hasMore !== (value.nextPageCursor !== undefined) || (value.hasMore && value.rows.length === 0)
    || value.rows.length > value.totalRows
    || Object.values(value.statusCounts).reduce<number>((sum, count) => sum + (count ?? 0), 0) !== value.totalRows
    || Object.keys(value.statusCounts).some(status => !(statuses as readonly string[]).includes(status))
    || Object.entries(value.statusCounts).some(([status, count]) => count !== undefined && count > 0 && value.manifest.filter !== 'all'
      && (value.manifest.filter === 'active' && value.manifest.feature === 'runs'
        ? ['completed', 'failed', 'cancelled', 'interrupted'].includes(status) : status !== value.manifest.filter))
    || (value.manifest.feature === 'decisions'
      ? Object.values(value.decisionKindCounts).reduce<number>((sum, count) => sum + (count ?? 0), 0) !== value.totalRows
      : Object.keys(value.decisionKindCounts).length > 0)) {
    context.addIssue({ code: 'custom', message: 'Catalog continuation contradicts its page.' });
  }
  if (value.rows.some((row, index) => !catalogRowMatches(row, value.manifest)
    || (index > 0 && compareCatalogRows(value.rows[index - 1]!, row) >= 0))) {
    context.addIssue({ code: 'custom', message: 'Catalog rows escaped scope, filter or order.' });
  }
});
export const publicProjectionCatalogPageResultSchema = z.union([publicProjectionCatalogPageSchema, publicProjectionCatalogResetSchema]);
export type PublicProjectionCatalogPageResult = z.infer<typeof publicProjectionCatalogPageResultSchema>;
export const publicProjectionCatalogDetailRequestSchema = z.object({ manifest: publicProjectionCatalogManifestSchema,
  aggregateId: publicProjectionCanonicalIdSchema }).strict();
export type PublicProjectionCatalogDetailRequest = z.infer<typeof publicProjectionCatalogDetailRequestSchema>;
export const publicProjectionCatalogDetailSchema = z.object({ status: z.literal('ok'), manifest: publicProjectionCatalogManifestSchema,
  aggregateId: publicProjectionCanonicalIdSchema, change: publicProjectionChangeSchema.nullable(), detailDigest: publicProjectionDigestSchema
}).strict().superRefine((value, context) => {
  if (value.change !== null && (value.change.feature !== value.manifest.feature || value.change.aggregateId !== value.aggregateId
    || (value.manifest.scope.kind === 'session' && value.change.dto !== null && 'sessionId' in value.change.dto
      && value.change.dto.sessionId !== value.manifest.scope.sessionId)
    || (value.manifest.scope.kind === 'directory' && value.manifest.scope.workspaceId !== undefined
      && value.change.feature === 'sessions' && value.change.dto !== null && value.change.dto.workspaceId !== value.manifest.scope.workspaceId))) {
    context.addIssue({ code: 'custom', message: 'Catalog detail escaped its owner.' });
  }
});
export const publicProjectionCatalogDetailResultSchema = z.union([publicProjectionCatalogDetailSchema, publicProjectionCatalogResetSchema]);
export type PublicProjectionCatalogDetailResult = z.infer<typeof publicProjectionCatalogDetailResultSchema>;
export const publicProjectionCatalogReadRequestSchema = z.object({ manifest: publicProjectionCatalogManifestSchema,
  afterCursor: cursor, afterDigest: publicProjectionDigestSchema, limit: z.number().int().min(1).max(256) }).strict();
export type PublicProjectionCatalogReadRequest = z.infer<typeof publicProjectionCatalogReadRequestSchema>;
const changeSchema = z.object({ feature, aggregateId: publicProjectionCanonicalIdSchema,
  aggregateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), operation: z.enum(['upsert', 'remove']),
  projectedAt: publicProjectionCanonicalTimestampSchema, row: publicProjectionCatalogRowSchema.nullable()
}).strict().superRefine((value, context) => {
  const identity = value.row === null ? undefined : catalogRowKey(value.row).id;
  if ((value.operation === 'remove') !== (value.row === null) || (value.row !== null
    && (value.row.feature !== value.feature || identity !== value.aggregateId || value.row.dto.version !== value.aggregateVersion))) {
    context.addIssue({ code: 'custom', message: 'Catalog change identity contradicts its body.' });
  }
});
export const publicProjectionCatalogBatchSchema = z.object({ status: z.literal('ok'), manifest: publicProjectionCatalogManifestSchema,
  afterCursor: cursor, afterDigest: publicProjectionDigestSchema, nextCursor: cursor, nextDigest: publicProjectionDigestSchema,
  hasMore: z.boolean(), entries: z.array(z.object({ cursor: cursor.refine(value => value > 0), cursorDigest: publicProjectionDigestSchema,
    payloadDigest: publicProjectionDigestSchema, eventId: publicProjectionCanonicalIdSchema, sourceId: publicProjectionCanonicalIdSchema,
    sourceCursor: cursor.refine(value => value > 0), occurredAt: publicProjectionCanonicalTimestampSchema,
    changes: z.array(changeSchema).max(256) }).strict()).max(256), batchDigest: publicProjectionDigestSchema
}).strict().superRefine((value, context) => {
  const last = value.entries.at(-1);
  if (value.afterCursor < value.manifest.boundaryCursor || value.nextCursor !== (last?.cursor ?? value.afterCursor)
    || value.nextDigest !== (last?.cursorDigest ?? value.afterDigest) || (value.hasMore && value.entries.length === 0)
    || ((value.afterCursor === 0) !== (value.afterDigest === PUBLIC_PROJECTION_GENESIS_DIGEST))
    || value.entries.some((entry, index) => entry.cursor !== value.afterCursor + index + 1
      || entry.changes.some(change => change.feature !== value.manifest.feature
        || (change.row !== null && !catalogRowMatches(change.row, value.manifest))))) {
    context.addIssue({ code: 'custom', message: 'Catalog scan escaped its boundary or selection.' });
  }
});
export const publicProjectionCatalogBatchResultSchema = z.union([publicProjectionCatalogBatchSchema, publicProjectionCatalogResetSchema]);
export type PublicProjectionCatalogBatchResult = z.infer<typeof publicProjectionCatalogBatchResultSchema>;

export function assertProjectionCatalogResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.parse(value);
  assertPublicProjectionPayloadSafe(result);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(result)).byteLength > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
    throw new Error('projection_catalog_byte_limit_exceeded');
  }
  return result;
}
export async function verifyCatalogBatch(request: PublicProjectionCatalogReadRequest, value: unknown): Promise<PublicProjectionCatalogBatchResult> {
  const batch = assertProjectionCatalogResult(publicProjectionCatalogBatchResultSchema, value);
  if (batch.status !== 'ok') return batch;
  if (canonicalPublicProjectionJson(batch.manifest) !== canonicalPublicProjectionJson(request.manifest)
    || batch.afterCursor !== request.afterCursor || batch.afterDigest !== request.afterDigest || batch.entries.length > request.limit) {
    throw new Error('projection_catalog_read_request_mismatch');
  }
  let previous = request.afterDigest;
  for (const entry of batch.entries) {
    if (entry.cursorDigest !== await catalogSha256(`${PUBLIC_PROJECTION_HISTORY_DOMAIN}\u0000${previous}\u0000${entry.cursor}\u0000${entry.payloadDigest}`)) {
      throw new Error('projection_catalog_history_mismatch');
    }
    previous = entry.cursorDigest;
  }
  const { batchDigest, ...payload } = batch;
  if (batchDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_catalog_batch_digest_mismatch');
  return batch;
}
export async function catalogSha256(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class PublicProjectionCatalogPageChain {
  private nextIndex = 0;
  private previousDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  private last: PublicProjectionCatalogRow | undefined;
  private count = 0;
  private totals: string | null = null;
  private done = false;
  private operation: Promise<void> = Promise.resolve();
  constructor(readonly manifest: PublicProjectionCatalogManifest) {}
  /** Capture accepted state only. A reader can validate a prospective page
   * without advancing the chain belonging to its last published window. */
  fork(): PublicProjectionCatalogPageChain {
    const copy = new PublicProjectionCatalogPageChain(this.manifest);
    copy.nextIndex = this.nextIndex; copy.previousDigest = this.previousDigest;
    copy.last = this.last; copy.count = this.count; copy.totals = this.totals; copy.done = this.done;
    return copy;
  }
  accept(value: unknown): Promise<Extract<PublicProjectionCatalogPageResult, { status: 'ok' }>> {
    const operation = this.operation.then(async () => {
      const page = assertProjectionCatalogResult(publicProjectionCatalogPageResultSchema, value);
      if (page.status !== 'ok') throw new Error(`projection_catalog_reset_required:${page.reason}`);
      if (this.done || page.pageIndex !== this.nextIndex || page.previousPageDigest !== this.previousDigest
        || canonicalPublicProjectionJson(page.manifest) !== canonicalPublicProjectionJson(this.manifest)) {
        throw new Error('projection_catalog_page_chain_mismatch');
      }
      const totals = canonicalPublicProjectionJson({ totalRows: page.totalRows, statusCounts: page.statusCounts,
        decisionKindCounts: page.decisionKindCounts });
      if (this.totals !== null && totals !== this.totals) throw new Error('projection_catalog_totals_mismatch');
      if (this.last !== undefined && page.rows[0] !== undefined && compareCatalogRows(this.last, page.rows[0]) >= 0) {
        throw new Error('projection_catalog_page_order_mismatch');
      }
      const { pageDigest, nextPageCursor: _cursor, ...payload } = page;
      if (pageDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_catalog_page_digest_mismatch');
      if (this.count + page.rows.length > page.totalRows || (!page.hasMore && this.count + page.rows.length !== page.totalRows)) {
        throw new Error('projection_catalog_page_count_mismatch');
      }
      this.count += page.rows.length; this.totals = totals;
      this.last = page.rows.at(-1) ?? this.last; this.previousDigest = page.pageDigest;
      this.nextIndex += 1; this.done = !page.hasMore;
      return page;
    });
    this.operation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
