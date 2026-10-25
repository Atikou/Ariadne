import { z } from 'zod';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  assertPublicProjectionPayloadSafe,
  canonicalPublicProjectionJson,
  publicProjectionCanonicalIdSchema,
  publicProjectionCanonicalTimestampSchema,
  publicProjectionChangeSchema,
  publicProjectionDigestSchema,
  type PublicProjectionFeature
} from './projection.js';

export const PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION = '1.0' as const;
export const MAX_PUBLIC_PROJECTION_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PUBLIC_PROJECTION_PAGE_ROWS = 256;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Message bodies can only be queried under one exact Session owner. */
export const publicProjectionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), workspaceId: publicProjectionCanonicalIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('session'), workspaceId: publicProjectionCanonicalIdSchema,
    sessionId: publicProjectionCanonicalIdSchema }).strict(),
  z.object({ kind: z.literal('decisions'), workspaceId: publicProjectionCanonicalIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('tasks'), workspaceId: publicProjectionCanonicalIdSchema.optional() }).strict()
]);
export type PublicProjectionScope = z.infer<typeof publicProjectionScopeSchema>;

export function publicProjectionScopeFeatures(scope: PublicProjectionScope): readonly PublicProjectionFeature[] {
  switch (scope.kind) {
    case 'directory': return ['diagnostics', 'models', 'sessions'];
    case 'session': return ['decisions', 'inference_streams', 'messages', 'runs'];
    case 'decisions': return ['decisions'];
    case 'tasks': return ['runs'];
  }
}

export const publicProjectionSnapshotManifestSchema = z.object({
  pageContractVersion: z.literal(PUBLIC_PROJECTION_PAGE_CONTRACT_VERSION),
  projectionContractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  snapshotId: publicProjectionCanonicalIdSchema,
  streamId: publicProjectionCanonicalIdSchema,
  boundaryCursor: cursor,
  boundaryDigest: publicProjectionDigestSchema,
  scope: publicProjectionScopeSchema,
  capturedAt: publicProjectionCanonicalTimestampSchema,
  expiresAt: publicProjectionCanonicalTimestampSchema
}).strict().superRefine((value, context) => {
  if ((value.boundaryCursor === 0) !== (value.boundaryDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)) {
    context.addIssue({ code: 'custom', path: ['boundaryDigest'], message: 'Boundary digest contradicts its cursor.' });
  }
  if (value.expiresAt <= value.capturedAt) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Snapshot expiry must follow capture.' });
  }
});
export type PublicProjectionSnapshotManifest = z.infer<typeof publicProjectionSnapshotManifestSchema>;

export const publicProjectionSnapshotBeginRequestSchema = z.object({
  pageContractVersion: z.string().min(1).max(32),
  scope: publicProjectionScopeSchema
}).strict();
export type PublicProjectionSnapshotBeginRequest = z.infer<typeof publicProjectionSnapshotBeginRequestSchema>;

export const publicProjectionSnapshotPageRequestSchema = z.object({
  pageContractVersion: z.string().min(1).max(32),
  snapshotId: publicProjectionCanonicalIdSchema,
  streamId: publicProjectionCanonicalIdSchema,
  boundaryCursor: cursor,
  boundaryDigest: publicProjectionDigestSchema,
  scope: publicProjectionScopeSchema,
  pageCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u).optional(),
  limit: z.number().int().min(1).max(MAX_PUBLIC_PROJECTION_PAGE_ROWS)
}).strict();
export type PublicProjectionSnapshotPageRequest = z.infer<typeof publicProjectionSnapshotPageRequestSchema>;

export const publicProjectionSnapshotPageSchema = z.object({
  status: z.literal('ok'),
  manifest: publicProjectionSnapshotManifestSchema,
  pageIndex: cursor,
  previousPageDigest: publicProjectionDigestSchema,
  pageDigest: publicProjectionDigestSchema,
  changes: z.array(publicProjectionChangeSchema).max(MAX_PUBLIC_PROJECTION_PAGE_ROWS),
  hasMore: z.boolean(),
  nextPageCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/u).optional()
}).strict().superRefine((value, context) => {
  if ((value.pageIndex === 0) !== (value.previousPageDigest === PUBLIC_PROJECTION_GENESIS_DIGEST)) {
    context.addIssue({ code: 'custom', path: ['previousPageDigest'], message: 'Page chain must start at genesis.' });
  }
  if (value.hasMore !== (value.nextPageCursor !== undefined) || (value.hasMore && value.changes.length === 0)) {
    context.addIssue({ code: 'custom', path: ['hasMore'], message: 'A continuation requires rows and a cursor.' });
  }
  const features = publicProjectionScopeFeatures(value.manifest.scope);
  let previousKey = '';
  for (const change of value.changes) {
    const key = `${change.feature}\u0000${change.aggregateId}`;
    if (!features.includes(change.feature) || key <= previousKey) {
      context.addIssue({ code: 'custom', path: ['changes'], message: 'Page rows must be in scope and strictly ordered.' });
    }
    previousKey = key;
    if (value.manifest.scope.kind === 'decisions' && (change.feature !== 'decisions'
      || change.dto === null || change.dto.status !== 'pending')) {
      context.addIssue({ code: 'custom', path: ['changes'], message: 'Notification scope contains pending Decisions only.' });
    }
    if (value.manifest.scope.kind === 'session' && change.dto !== null
      && 'sessionId' in change.dto && change.dto.sessionId !== value.manifest.scope.sessionId) {
      context.addIssue({ code: 'custom', path: ['changes'], message: 'Entity belongs to another Session.' });
    }
  }
});
export type PublicProjectionSnapshotPage = z.infer<typeof publicProjectionSnapshotPageSchema>;

export const publicProjectionSnapshotPageResetSchema = z.object({
  status: z.literal('reset_required'),
  reason: z.enum(['contract_mismatch', 'stream_mismatch', 'snapshot_expired', 'scope_mismatch',
    'boundary_mismatch', 'page_cursor_invalid', 'history_unavailable']),
  streamId: publicProjectionCanonicalIdSchema
}).strict();
export const publicProjectionSnapshotPageResultSchema = z.union([
  publicProjectionSnapshotPageSchema, publicProjectionSnapshotPageResetSchema
]);
export type PublicProjectionSnapshotPageResult = z.infer<typeof publicProjectionSnapshotPageResultSchema>;

/** Digest excludes continuation tokens; tokens authenticate the returned chain separately. */
export function publicProjectionPageDigestPayload(page: Omit<PublicProjectionSnapshotPage, 'pageDigest'>): string {
  const { nextPageCursor: _nextPageCursor, ...payload } = page;
  return canonicalPublicProjectionJson(payload);
}

export function assertPublicProjectionSnapshotPage(value: unknown): PublicProjectionSnapshotPageResult {
  const page = publicProjectionSnapshotPageResultSchema.parse(value);
  assertPublicProjectionPayloadSafe(page);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(page)).byteLength > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
    throw new Error('public_projection_page_byte_limit_exceeded');
  }
  return page;
}

/** Validates pages before a consumer publishes its independent staging cache. */
export class PublicProjectionPageChain {
  private readonly manifest: PublicProjectionSnapshotManifest;
  private pageIndex = 0;
  private previousDigest: string = PUBLIC_PROJECTION_GENESIS_DIGEST;
  private previousKey = '';
  private complete = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(manifest: unknown) {
    this.manifest = publicProjectionSnapshotManifestSchema.parse(manifest);
  }

  accept(value: unknown): Promise<PublicProjectionSnapshotPage> {
    const operation = this.tail.then(async () => {
      const page = assertPublicProjectionSnapshotPage(value);
      if (page.status !== 'ok') throw new Error(`public_projection_snapshot_reset:${page.reason}`);
      if (this.complete || page.pageIndex !== this.pageIndex
        || page.previousPageDigest !== this.previousDigest
        || canonicalPublicProjectionJson(page.manifest) !== canonicalPublicProjectionJson(this.manifest)) {
        throw new Error('public_projection_page_chain_mismatch');
      }
      const first = page.changes[0];
      if (first !== undefined && `${first.feature}\u0000${first.aggregateId}` <= this.previousKey) {
        throw new Error('public_projection_page_order_mismatch');
      }
      const { pageDigest, ...payload } = page;
      const digest = await globalThis.crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(publicProjectionPageDigestPayload(payload)));
      const computed = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (computed !== pageDigest) throw new Error('public_projection_page_digest_mismatch');
      const last = page.changes.at(-1);
      if (last !== undefined) this.previousKey = `${last.feature}\u0000${last.aggregateId}`;
      this.previousDigest = pageDigest;
      this.pageIndex += 1;
      this.complete = !page.hasMore;
      return page;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  isComplete(): boolean { return this.complete; }
}
