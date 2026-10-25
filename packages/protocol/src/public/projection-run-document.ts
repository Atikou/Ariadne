import { z } from 'zod';
import { assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson, publicAgentInboxInputSchema,
  publicMessageProjectionSchema, publicProjectionCanonicalIdSchema, publicProjectionDigestSchema,
  publicToolActivityProjectionSchema } from './projection.js';
import { catalogSha256, publicRunCatalogSummarySchema } from './projection-catalog.js';

export const RUN_DOCUMENT_VERSION = '1.0' as const;
export const RUN_DOCUMENT_CHUNK_BYTES = 256 * 1024;
export const MAX_RUN_DOCUMENT_ITEM_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_DOCUMENT_LEAF_BYTES = 512 * 1024;
export const RUN_DOCUMENT_COLLECTIONS = ['toolActivities', 'inbox', 'interactionMessages'] as const;
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const collection = z.enum(RUN_DOCUMENT_COLLECTIONS);
const descriptor = z.object({ itemCount: ordinal, leafCount: ordinal, merkleRoot: publicProjectionDigestSchema }).strict()
  .refine(v => (v.itemCount === 0 ? v.leafCount === 0 : v.leafCount >= v.itemCount), 'Invalid collection counts.');
export const publicRunDocumentHeaderSchema = z.object({ documentContractVersion: z.literal(RUN_DOCUMENT_VERSION),
  summary: publicRunCatalogSummarySchema,
  collections: z.object({ toolActivities: descriptor, inbox: descriptor, interactionMessages: descriptor }).strict(),
  documentDigest: publicProjectionDigestSchema
}).strict().superRefine((v, c) => {
  if (v.summary.toolActivityCount !== v.collections.toolActivities.itemCount
    || v.summary.interactionMessageCount !== v.collections.interactionMessages.itemCount
    || v.summary.queuedInputCount + v.summary.claimedInputCount !== v.collections.inbox.itemCount) {
    c.addIssue({ code: 'custom', message: 'Document collections disagree with their summary.' });
  }
});
export type PublicRunDocumentHeader = z.infer<typeof publicRunDocumentHeaderSchema>;

// This independent format preserves the protected interaction resolver's
// existing 1 MiB character bound; the released 100k-character DTO is unchanged.
export const publicRunDocumentInteractionSchema = z.object({ ...publicMessageProjectionSchema.shape,
  content: z.string().min(1).max(1_048_576)
}).strict().superRefine(validateInteractionIdentity);
function validateInteractionIdentity(v: Omit<z.infer<typeof publicMessageProjectionSchema>, 'content'>, c: z.RefinementCtx): void {
  if (v.updatedAt < v.createdAt || (v.attachments !== undefined && v.role !== 'user')
    || (v.reference !== undefined && (v.reference.sessionId !== v.sessionId || v.reference.messageId !== v.messageId
      || v.reference.messageVersion !== v.version))) c.addIssue({ code: 'custom', message: 'Interaction identity or timeline mismatch.' });
}
export const publicRunDocumentItemSchema = z.discriminatedUnion('collection', [
  z.object({ collection: z.literal('toolActivities'), value: publicToolActivityProjectionSchema }).strict(),
  z.object({ collection: z.literal('inbox'), value: publicAgentInboxInputSchema }).strict(),
  z.object({ collection: z.literal('interactionMessages'), value: publicRunDocumentInteractionSchema }).strict()
]);
export type PublicRunDocumentItem = z.infer<typeof publicRunDocumentItemSchema>;
const { content: _interactionContent, ...interactionMetadataFields } = publicRunDocumentInteractionSchema.shape;
export const publicRunDocumentItemMetadataSchema = z.discriminatedUnion('collection', [
  z.object({ collection: z.literal('toolActivities'), value: publicToolActivityProjectionSchema }).strict(),
  z.object({ collection: z.literal('inbox'), value: publicAgentInboxInputSchema.omit({ content: true }) }).strict(),
  z.object({ collection: z.literal('interactionMessages'), value: z.object(interactionMetadataFields).strict().superRefine(validateInteractionIdentity) }).strict()
]);
export type PublicRunDocumentItemMetadata = z.infer<typeof publicRunDocumentItemMetadataSchema>;
export function runDocumentItemMetadata(item: PublicRunDocumentItem): PublicRunDocumentItemMetadata {
  if (item.collection === 'toolActivities') return publicRunDocumentItemMetadataSchema.parse(item);
  const { content: _content, ...value } = item.value;
  return publicRunDocumentItemMetadataSchema.parse({ collection: item.collection, value });
}
export function runDocumentItemMetadataData(value: PublicRunDocumentItemMetadata): string {
  return `ariadne.run-document.item-metadata.v1\0${canonicalPublicProjectionJson(value)}`;
}
export const publicRunDocumentLeafDescriptorSchema = z.object({
  documentContractVersion: z.literal(RUN_DOCUMENT_VERSION), runId: publicProjectionCanonicalIdSchema,
  runVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), collection,
  itemOrdinal: ordinal, itemId: publicProjectionCanonicalIdSchema, itemDigest: publicProjectionDigestSchema,
  itemMetadataDigest: publicProjectionDigestSchema,
  itemBytes: z.number().int().positive().max(MAX_RUN_DOCUMENT_ITEM_BYTES),
  chunkOrdinal: z.number().int().nonnegative().max(31), chunkCount: z.number().int().positive().max(32),
  chunkBytes: z.number().int().positive().max(RUN_DOCUMENT_CHUNK_BYTES), chunkDigest: publicProjectionDigestSchema,
  leafIndex: ordinal
}).strict().superRefine((v, c) => {
  if (v.chunkCount !== Math.ceil(v.itemBytes / RUN_DOCUMENT_CHUNK_BYTES) || v.chunkOrdinal >= v.chunkCount
    || v.chunkBytes !== Math.min(RUN_DOCUMENT_CHUNK_BYTES, v.itemBytes - v.chunkOrdinal * RUN_DOCUMENT_CHUNK_BYTES)) {
    c.addIssue({ code: 'custom', message: 'Item chunk coverage is inconsistent.' });
  }
});
export type PublicRunDocumentLeafDescriptor = z.infer<typeof publicRunDocumentLeafDescriptorSchema>;
export const publicRunDocumentLeafSchema = z.object({ descriptor: publicRunDocumentLeafDescriptorSchema,
  contentBase64: z.string().min(4).max(4 * Math.ceil(RUN_DOCUMENT_CHUNK_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  siblings: z.array(publicProjectionDigestSchema).max(53)
}).strict();
export type PublicRunDocumentLeaf = z.infer<typeof publicRunDocumentLeafSchema>;
export function runDocumentEmptyData(runId: string, version: number, kind: string): string {
  return `ariadne.run-document.empty.v1\0${canonicalPublicProjectionJson([runId, version, kind])}`;
}
export function runDocumentLeafData(value: PublicRunDocumentLeafDescriptor): string {
  return `ariadne.run-document.leaf.v1\0${canonicalPublicProjectionJson(value)}`;
}
export function runDocumentNodeData(level: number, left: string, right: string): string {
  return `ariadne.run-document.node.v1\0${level}\0${left}\0${right}`;
}
export function runDocumentHeaderData(value: Omit<PublicRunDocumentHeader, 'documentDigest'>): string {
  return `ariadne.run-document.header.v1\0${canonicalPublicProjectionJson(value)}`;
}
export function runDocumentItemId(item: PublicRunDocumentItem | PublicRunDocumentItemMetadata): string {
  return item.collection === 'toolActivities' ? item.value.activityId : item.collection === 'inbox'
    ? item.value.inputId : item.value.messageId;
}
/** A single verifier supports Web Crypto in the Renderer and synchronous
 * SHA-256 during SQLite startup audit. Every yield is a domain-separated
 * string or raw byte sequence; the driver supplies its SHA-256 digest. */
export type RunDocumentCheck<T> = Generator<string | Uint8Array, T, string>;
export async function runDocumentCheckAsync<T>(check: RunDocumentCheck<T>): Promise<T> {
  let step = check.next();
  while (!step.done) {
    const hash = typeof step.value === 'string' ? await catalogSha256(step.value) : await runDocumentBytesDigest(step.value);
    step = check.next(hash);
  }
  return step.value;
}
export function* verifyRunDocumentHeaderSteps(value: unknown): RunDocumentCheck<PublicRunDocumentHeader> {
  const header = publicRunDocumentHeaderSchema.parse(value);
  assertPublicProjectionPayloadSafe(header);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(header)).length > 32 * 1024) throw new Error('run_document_header_too_large');
  const { documentDigest, ...data } = header;
  if (documentDigest !== (yield runDocumentHeaderData(data))) throw new Error('run_document_header_digest_mismatch');
  for (const kind of RUN_DOCUMENT_COLLECTIONS) if (header.collections[kind].leafCount === 0
    && header.collections[kind].merkleRoot !== (yield runDocumentEmptyData(header.summary.runId, header.summary.version, kind))) {
    throw new Error('run_document_empty_root_mismatch');
  }
  return header;
}
export async function verifyRunDocumentHeader(value: unknown): Promise<PublicRunDocumentHeader> {
  return runDocumentCheckAsync(verifyRunDocumentHeaderSteps(value));
}
export async function runDocumentBytesDigest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function* verifyRunDocumentLeafSteps(headerValue: unknown, value: unknown): RunDocumentCheck<{
  header: PublicRunDocumentHeader; descriptor: PublicRunDocumentLeafDescriptor; bytes: Uint8Array
}> {
  const leaf = publicRunDocumentLeafSchema.parse(value);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(leaf)).length > MAX_RUN_DOCUMENT_LEAF_BYTES) throw new Error('run_document_leaf_too_large');
  const { header, descriptor: d } = yield* verifyRunDocumentLeafDescriptorSteps(headerValue, leaf.descriptor, leaf.siblings);
  const bytes = Uint8Array.from(atob(leaf.contentBase64), char => char.charCodeAt(0));
  const remainder = bytes.length % 3;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((remainder === 1 && (alphabet.indexOf(leaf.contentBase64.at(-3)!) & 15) !== 0)
    || (remainder === 2 && (alphabet.indexOf(leaf.contentBase64.at(-2)!) & 3) !== 0)) throw new Error('run_document_base64_noncanonical');
  if (bytes.length !== d.chunkBytes || (yield bytes) !== d.chunkDigest) throw new Error('run_document_chunk_digest_mismatch');
  return { header, descriptor: d, bytes };
}
export async function verifyRunDocumentLeaf(headerValue: unknown, value: unknown) {
  return runDocumentCheckAsync(verifyRunDocumentLeafSteps(headerValue, value));
}
export function* verifyRunDocumentLeafDescriptorSteps(headerValue: unknown, descriptorValue: unknown, siblingsValue: unknown):
  RunDocumentCheck<{ header: PublicRunDocumentHeader; descriptor: PublicRunDocumentLeafDescriptor }> {
  const header = yield* verifyRunDocumentHeaderSteps(headerValue), d = publicRunDocumentLeafDescriptorSchema.parse(descriptorValue);
  const siblings = z.array(publicProjectionDigestSchema).max(53).parse(siblingsValue), selected = header.collections[d.collection];
  if (d.runId !== header.summary.runId || d.runVersion !== header.summary.version
    || d.itemOrdinal >= selected.itemCount || d.leafIndex >= selected.leafCount) throw new Error('run_document_leaf_owner_mismatch');
  let hash = yield runDocumentLeafData(d), index = d.leafIndex, width = selected.leafCount, level = 0;
  while (width > 1) {
    const sibling = siblings[level];
    if (sibling === undefined || (index % 2 === 0 && index + 1 >= width && sibling !== hash)) throw new Error('run_document_proof_incomplete');
    hash = yield (index % 2 === 0 ? runDocumentNodeData(level, hash, sibling) : runDocumentNodeData(level, sibling, hash));
    index = Math.floor(index / 2); width = Math.ceil(width / 2); level++;
  }
  if (siblings.length !== level || hash !== selected.merkleRoot) throw new Error('run_document_proof_mismatch');
  return { header, descriptor: d };
}
export async function verifyRunDocumentLeafDescriptor(headerValue: unknown, descriptorValue: unknown, siblingsValue: unknown) {
  return runDocumentCheckAsync(verifyRunDocumentLeafDescriptorSteps(headerValue, descriptorValue, siblingsValue));
}
export function* verifyRunDocumentItemMetadataSteps(headerValue: unknown, descriptorValue: unknown, siblingsValue: unknown, metadataValue: unknown):
  RunDocumentCheck<PublicRunDocumentItemMetadata> {
  const { header, descriptor: d } = yield* verifyRunDocumentLeafDescriptorSteps(headerValue, descriptorValue, siblingsValue);
  const metadata = publicRunDocumentItemMetadataSchema.parse(metadataValue);
  assertPublicProjectionPayloadSafe(metadata);
  if (metadata.collection !== d.collection || runDocumentItemId(metadata) !== d.itemId
    || (metadata.collection === 'interactionMessages' && (metadata.value.runId !== header.summary.runId
      || metadata.value.sessionId !== header.summary.sessionId))) throw new Error('run_document_item_owner_mismatch');
  if ((yield runDocumentItemMetadataData(metadata)) !== d.itemMetadataDigest) throw new Error('run_document_item_metadata_digest_mismatch');
  return metadata;
}
export async function verifyRunDocumentItemMetadata(headerValue: unknown, descriptorValue: unknown, siblingsValue: unknown, metadataValue: unknown) {
  return runDocumentCheckAsync(verifyRunDocumentItemMetadataSteps(headerValue, descriptorValue, siblingsValue, metadataValue));
}

/** One explicitly requested item only. No complete Run body is assembled. */
export class RunDocumentItemAssembler {
  private chunks: Uint8Array[] = [];
  private previous: PublicRunDocumentLeafDescriptor | null = null;
  private finished = false;
  constructor(private readonly header: PublicRunDocumentHeader, private readonly collection: PublicRunDocumentItem['collection'],
    private readonly itemOrdinal: number) {}
  async accept(value: unknown): Promise<PublicRunDocumentItem | null> {
    return runDocumentCheckAsync(this.acceptSteps(value));
  }
  *acceptSteps(value: unknown): RunDocumentCheck<PublicRunDocumentItem | null> {
    if (this.finished) throw new Error('run_document_item_already_completed');
    const { descriptor: d, bytes } = yield* verifyRunDocumentLeafSteps(this.header, value);
    const previous = this.previous;
    if (d.collection !== this.collection || d.itemOrdinal !== this.itemOrdinal || d.chunkOrdinal !== this.chunks.length
      || (previous !== null && (d.itemId !== previous.itemId || d.itemDigest !== previous.itemDigest
        || d.itemMetadataDigest !== previous.itemMetadataDigest || d.itemBytes !== previous.itemBytes
        || d.chunkCount !== previous.chunkCount || d.leafIndex !== previous.leafIndex + 1))) {
      throw new Error('run_document_item_sequence_mismatch');
    }
    this.chunks.push(bytes); this.previous = d;
    if (this.chunks.length !== d.chunkCount) return null;
    this.finished = true;
    const body = new Uint8Array(d.itemBytes); let offset = 0;
    for (const chunk of this.chunks) { body.set(chunk, offset); offset += chunk.length; }
    this.chunks = [];
    if (offset !== body.length || (yield body) !== d.itemDigest) throw new Error('run_document_item_digest_mismatch');
    const item = publicRunDocumentItemSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
    assertPublicProjectionPayloadSafe(item);
    if ((yield runDocumentItemMetadataData(runDocumentItemMetadata(item))) !== d.itemMetadataDigest) {
      throw new Error('run_document_item_metadata_digest_mismatch');
    }
    if (item.collection !== this.collection || runDocumentItemId(item) !== d.itemId
      || (item.collection === 'interactionMessages' && (item.value.runId !== this.header.summary.runId
        || item.value.sessionId !== this.header.summary.sessionId))) throw new Error('run_document_item_owner_mismatch');
    return item;
  }
}
