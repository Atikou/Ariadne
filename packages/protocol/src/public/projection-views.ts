import { z } from 'zod';
import {
  assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson, publicProjectionFeatureSchema,
  publicProjectionCanonicalIdSchema, publicProjectionDigestSchema, publicProjectionChangeSchema
} from './projection.js';
import {
  MAX_PUBLIC_PROJECTION_PAGE_BYTES, publicProjectionScopeFeatures,
  publicProjectionSnapshotBeginRequestSchema, publicProjectionSnapshotManifestSchema,
  publicProjectionSnapshotPageRequestSchema, publicProjectionSnapshotPageSchema,
  publicProjectionSnapshotPageResetSchema
} from './projection-pages.js';

export const PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION = '2.0' as const;
const selectedFeatures = z.array(publicProjectionFeatureSchema).min(1).max(7);
export const publicProjectionViewBeginRequestSchema = publicProjectionSnapshotBeginRequestSchema.safeExtend({
  features: selectedFeatures
}).superRefine((value, context) => {
  const allowed = publicProjectionScopeFeatures(value.scope);
  if (value.features.some((feature, index) => !allowed.includes(feature)
    || (index > 0 && feature <= value.features[index - 1]!))) {
    context.addIssue({ code: 'custom', message: 'Selected features must be in scope, unique and sorted.' });
  }
});
export type PublicProjectionViewBeginRequest = z.infer<typeof publicProjectionViewBeginRequestSchema>;
export const publicProjectionViewManifestSchema = z.object({ ...publicProjectionSnapshotManifestSchema.shape,
  pageContractVersion: z.literal(PUBLIC_PROJECTION_VIEW_CONTRACT_VERSION), selectedFeatures
}).strict().superRefine((value, context) => {
  const { selectedFeatures: _features, ...base } = value;
  if (!publicProjectionSnapshotManifestSchema.safeParse({ ...base, pageContractVersion: '1.0' }).success) {
    context.addIssue({ code: 'custom', message: 'Snapshot boundary or expiry is invalid.' });
  }
  const allowed = publicProjectionScopeFeatures(value.scope);
  if (value.selectedFeatures.some((feature, index) => !allowed.includes(feature)
    || (index > 0 && feature <= value.selectedFeatures[index - 1]!))) {
    context.addIssue({ code: 'custom', message: 'Manifest feature selection is invalid.' });
  }
});
export type PublicProjectionViewManifest = z.infer<typeof publicProjectionViewManifestSchema>;
export const publicProjectionViewPageRequestSchema = publicProjectionSnapshotPageRequestSchema.safeExtend({
  selectedFeatures
});
export type PublicProjectionViewPageRequest = z.infer<typeof publicProjectionViewPageRequestSchema>;
export const publicProjectionViewPageSchema = z.object({ ...publicProjectionSnapshotPageSchema.shape,
  manifest: publicProjectionViewManifestSchema
}).strict().superRefine((value, context) => {
  const { selectedFeatures: _features, ...base } = value.manifest;
  if (!publicProjectionSnapshotPageSchema.safeParse({ ...value, manifest: { ...base, pageContractVersion: '1.0' } }).success) {
    context.addIssue({ code: 'custom', message: 'Page chain, scope, order or continuation is invalid.' });
  }
  if (value.changes.some(change => !value.manifest.selectedFeatures.includes(change.feature))) {
    context.addIssue({ code: 'custom', message: 'Page escaped its manifest feature selection.' });
  }
});
export const publicProjectionViewPageResultSchema = z.union([publicProjectionViewPageSchema, publicProjectionSnapshotPageResetSchema]);
export type PublicProjectionViewPageResult = z.infer<typeof publicProjectionViewPageResultSchema>;
export type PublicProjectionViewPage = z.infer<typeof publicProjectionViewPageSchema>;

export const publicProjectionMessageWindowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('latest'), limit: z.number().int().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('before'), anchorMessageId: publicProjectionCanonicalIdSchema,
    limit: z.number().int().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('around'), anchorMessageId: publicProjectionCanonicalIdSchema,
    limit: z.number().int().min(1).max(128) }).strict()
]);
export type PublicProjectionMessageWindow = z.infer<typeof publicProjectionMessageWindowSchema>;
export const publicProjectionMessageWindowRequestSchema = z.object({
  manifest: publicProjectionViewManifestSchema, window: publicProjectionMessageWindowSchema
}).strict().superRefine((value, context) => {
  if (value.manifest.scope.kind !== 'session') context.addIssue({ code: 'custom', message: 'Message windows require a Session scope.' });
});
export type PublicProjectionMessageWindowRequest = z.infer<typeof publicProjectionMessageWindowRequestSchema>;
export const publicProjectionMessageWindowOkSchema = z.object({
  status: z.literal('ok'), manifest: publicProjectionViewManifestSchema,
  window: publicProjectionMessageWindowSchema,
  changes: z.array(publicProjectionChangeSchema).max(128),
  hasEarlier: z.boolean(), hasLater: z.boolean(), windowDigest: publicProjectionDigestSchema
}).strict().superRefine((value, context) => {
  if (value.manifest.scope.kind !== 'session') {
    context.addIssue({ code: 'custom', message: 'Message windows require a Session scope.' });
    return;
  }
  const sessionId = value.manifest.scope.sessionId;
  const seen = new Set<string>();
  if (value.changes.length > value.window.limit || value.changes.some(change => {
    const duplicate = seen.has(change.aggregateId);
    seen.add(change.aggregateId);
    return duplicate || change.feature !== 'messages' || change.dto === null || change.operation !== 'upsert'
      || change.dto.sessionId !== sessionId;
  })) context.addIssue({ code: 'custom', message: 'Message window rows escaped their owner or limit.' });
  if (value.window.kind === 'around' && !seen.has(value.window.anchorMessageId)) {
    context.addIssue({ code: 'custom', message: 'An around window must include its anchor.' });
  }
});
export const publicProjectionMessageWindowResultSchema = z.union([
  publicProjectionMessageWindowOkSchema, publicProjectionSnapshotPageResetSchema,
  z.object({ status: z.literal('anchor_unavailable'), snapshotId: publicProjectionCanonicalIdSchema }).strict()
]);
export type PublicProjectionMessageWindowResult = z.infer<typeof publicProjectionMessageWindowResultSchema>;
export type PublicProjectionMessageWindowOk = z.infer<typeof publicProjectionMessageWindowOkSchema>;

/** Uses the same binary order as SQLite, including equal-time role and ID ties. */
export function comparePublicProjectionMessages(left: { createdAt: string; role: string; messageId: string },
  right: { createdAt: string; role: string; messageId: string }): number {
  const role = (value: string) => value === 'user' ? 0 : value === 'assistant' ? 1 : 2;
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1
    : role(left.role) - role(right.role) || (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0);
}

export class PublicProjectionViewPageChain {
  private readonly manifest: PublicProjectionViewManifest;
  private index = 0;
  private previousDigest = `sha256:${'0'.repeat(64)}`;
  private previousKey = '';
  private complete = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(manifest: unknown) { this.manifest = publicProjectionViewManifestSchema.parse(manifest); }
  accept(value: unknown): Promise<PublicProjectionViewPage> {
    const operation = this.tail.then(async () => {
      const page = assertPublicProjectionViewPage(value);
      if (page.status !== 'ok') throw new Error(`public_projection_snapshot_reset:${page.reason}`);
      if (this.complete || page.pageIndex !== this.index || page.previousPageDigest !== this.previousDigest
        || canonicalPublicProjectionJson(page.manifest) !== canonicalPublicProjectionJson(this.manifest)) {
        throw new Error('public_projection_view_page_chain_mismatch');
      }
      const first = page.changes[0];
      if (first !== undefined && `${first.feature}\u0000${first.aggregateId}` <= this.previousKey) {
        throw new Error('public_projection_view_page_order_mismatch');
      }
      const { pageDigest, nextPageCursor: _cursor, ...payload } = page;
      if (pageDigest !== await sha256(canonicalPublicProjectionJson(payload))) throw new Error('public_projection_view_page_digest_mismatch');
      const last = page.changes.at(-1);
      if (last !== undefined) this.previousKey = `${last.feature}\u0000${last.aggregateId}`;
      this.index += 1;
      this.previousDigest = pageDigest;
      this.complete = !page.hasMore;
      return page;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  isComplete(): boolean { return this.complete; }
}

export async function verifyPublicProjectionMessageWindow(request: PublicProjectionMessageWindowRequest,
  value: unknown): Promise<PublicProjectionMessageWindowResult> {
  request = publicProjectionMessageWindowRequestSchema.parse(request);
  const result = assertPublicProjectionMessageWindow(value);
  if (result.status === 'anchor_unavailable'
    && (result.snapshotId !== request.manifest.snapshotId || request.window.kind === 'latest')) {
    throw new Error('public_projection_message_window_request_mismatch');
  }
  if (result.status !== 'ok') return result;
  if (canonicalPublicProjectionJson(request.manifest) !== canonicalPublicProjectionJson(result.manifest)
    || canonicalPublicProjectionJson(request.window) !== canonicalPublicProjectionJson(result.window)) {
    throw new Error('public_projection_message_window_request_mismatch');
  }
  let previous: { createdAt: string; role: string; messageId: string } | undefined;
  for (const change of result.changes) {
    if (change.feature !== 'messages' || change.dto === null) throw new Error('public_projection_message_window_row_invalid');
    if (previous !== undefined && comparePublicProjectionMessages(previous, change.dto) >= 0) {
      throw new Error('public_projection_message_window_order_mismatch');
    }
    previous = change.dto;
  }
  const { windowDigest, ...payload } = result;
  if (windowDigest !== await sha256(canonicalPublicProjectionJson(payload))) throw new Error('public_projection_message_window_digest_mismatch');
  return result;
}

export function assertPublicProjectionViewPage(value: unknown): PublicProjectionViewPageResult {
  return bounded(publicProjectionViewPageResultSchema.parse(value));
}
export function assertPublicProjectionMessageWindow(value: unknown): PublicProjectionMessageWindowResult {
  return bounded(publicProjectionMessageWindowResultSchema.parse(value));
}
function bounded<T>(value: T): T {
  assertPublicProjectionPayloadSafe(value);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(value)).byteLength > MAX_PUBLIC_PROJECTION_PAGE_BYTES) {
    throw new Error('public_projection_view_byte_limit_exceeded');
  }
  return value;
}
async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
