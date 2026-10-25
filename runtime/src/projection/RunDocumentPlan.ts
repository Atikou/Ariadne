import { createHash } from 'node:crypto';
import { assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson, publicRunDocumentHeaderSchema,
  publicRunDocumentItemSchema, publicRunCatalogSummarySchema, runDocumentEmptyData, runDocumentHeaderData, runDocumentItemId,
  runDocumentItemMetadata, runDocumentItemMetadataData,
  runDocumentLeafData, runDocumentNodeData, MAX_RUN_DOCUMENT_ITEM_BYTES, RUN_DOCUMENT_CHUNK_BYTES,
  RUN_DOCUMENT_COLLECTIONS, RUN_DOCUMENT_VERSION, type PublicAgentInboxInput, type PublicRunCatalogSummary,
  type PublicRunDocumentHeader, type PublicRunDocumentItem, type PublicRunDocumentLeaf,
  type PublicRunDocumentLeafDescriptor, type PublicToolActivityProjection,
  type publicRunDocumentInteractionSchema } from '@ariadne/protocol/public';
import type { z } from 'zod';

export interface RunDocumentSource {
  readonly summary: PublicRunCatalogSummary;
  readonly toolActivities: readonly PublicToolActivityProjection[];
  readonly inbox: readonly PublicAgentInboxInput[];
  readonly interactionMessages: readonly z.infer<typeof publicRunDocumentInteractionSchema>[];
}
type Collection = typeof RUN_DOCUMENT_COLLECTIONS[number];
interface ItemIndex { readonly id: string; readonly digest: string; readonly metadataDigest: string;
  readonly bytes: number; readonly firstLeaf: number; readonly chunks: number }
interface CollectionIndex { readonly items: readonly ItemIndex[]; readonly levels: readonly (readonly string[])[] }

/** Preparation retains only IDs, byte counts and Merkle hashes. Body chunks
 * are regenerated one requested item at a time and must match the plan. */
export class RunDocumentPlan {
  readonly header: PublicRunDocumentHeader;
  private readonly indexes = new Map<Collection, CollectionIndex>();
  private readonly summary: PublicRunCatalogSummary;
  private readonly summaryJson: string;
  constructor(private readonly source: RunDocumentSource) {
    this.summary = publicRunCatalogSummarySchema.parse(source.summary);
    this.summaryJson = canonicalPublicProjectionJson(this.summary);
    const collections = {} as PublicRunDocumentHeader['collections'];
    let queued = 0, claimed = 0;
    for (const kind of RUN_DOCUMENT_COLLECTIONS) {
      const hashes: string[] = [], items: ItemIndex[] = [], ids = new Set<string>();
      for (let ordinal = 0; ordinal < source[kind].length; ordinal++) {
        const { item, bytes } = this.encode(kind, ordinal);
        if (item.collection === 'inbox') { if (item.value.state === 'queued') queued++; else claimed++; }
        const id = runDocumentItemId(item);
        if (ids.has(id)) throw new Error('run_document_duplicate_item'); ids.add(id);
        const info = { id, digest: digest(bytes), metadataDigest: digest(runDocumentItemMetadataData(runDocumentItemMetadata(item))),
          bytes: bytes.length, firstLeaf: hashes.length,
          chunks: Math.ceil(bytes.length / RUN_DOCUMENT_CHUNK_BYTES) };
        items.push(info);
        for (let chunk = 0; chunk < info.chunks; chunk++) {
          hashes.push(digest(runDocumentLeafData(this.descriptor(kind, ordinal, info, chunk, bytes))));
        }
      }
      const levels: string[][] = [hashes];
      for (let level = 0; levels[level]!.length > 1; level++) {
        const previous = levels[level]!, next: string[] = [];
        for (let index = 0; index < previous.length; index += 2) {
          next.push(digest(runDocumentNodeData(level, previous[index]!, previous[index + 1] ?? previous[index]!)));
        }
        levels.push(next);
      }
      this.indexes.set(kind, { items, levels });
      collections[kind] = { itemCount: items.length, leafCount: hashes.length,
        merkleRoot: levels.at(-1)![0] ?? digest(runDocumentEmptyData(this.summary.runId, this.summary.version, kind)) };
    }
    if (queued !== this.summary.queuedInputCount || claimed !== this.summary.claimedInputCount) throw new Error('run_document_inbox_counts_mismatch');
    const data = { documentContractVersion: RUN_DOCUMENT_VERSION, summary: this.summary, collections };
    this.header = publicRunDocumentHeaderSchema.parse({ ...data, documentDigest: digest(runDocumentHeaderData(data)) });
    assertPublicProjectionPayloadSafe(this.header);
  }
  *leaves(): IterableIterator<PublicRunDocumentLeaf> {
    for (const kind of RUN_DOCUMENT_COLLECTIONS) for (let ordinal = 0; ordinal < this.indexes.get(kind)!.items.length; ordinal++) {
      yield* this.itemLeaves(kind, ordinal);
    }
  }
  itemMetadata(kind: Collection, ordinal: number) {
    const { item, bytes } = this.encode(kind, ordinal), info = this.indexes.get(kind)!.items[ordinal];
    if (info === undefined || this.source[kind].length !== this.indexes.get(kind)!.items.length
      || canonicalPublicProjectionJson(this.source.summary) !== this.summaryJson
      || bytes.length !== info.bytes || digest(bytes) !== info.digest || runDocumentItemId(item) !== info.id) {
      throw new Error('run_document_source_drift');
    }
    return runDocumentItemMetadata(item);
  }
  *itemLeaves(kind: Collection, ordinal: number): IterableIterator<PublicRunDocumentLeaf> {
    const index = this.indexes.get(kind)!;
    if (this.source[kind].length !== index.items.length || canonicalPublicProjectionJson(this.source.summary) !== this.summaryJson) throw new Error('run_document_source_drift');
    const info = index.items[ordinal]; if (info === undefined) throw new Error('run_document_item_unavailable');
    const { item, bytes } = this.encode(kind, ordinal);
    if (bytes.length !== info.bytes || digest(bytes) !== info.digest || runDocumentItemId(item) !== info.id) throw new Error('run_document_source_drift');
    for (let chunk = 0; chunk < info.chunks; chunk++) {
      const descriptor = this.descriptor(kind, ordinal, info, chunk, bytes);
      const siblings: string[] = []; let leaf = descriptor.leafIndex;
      for (const level of index.levels.slice(0, -1)) {
        siblings.push(level[leaf ^ 1] ?? level[leaf]!); leaf = Math.floor(leaf / 2);
      }
      const content = bytes.subarray(chunk * RUN_DOCUMENT_CHUNK_BYTES, (chunk + 1) * RUN_DOCUMENT_CHUNK_BYTES);
      yield { descriptor, contentBase64: content.toString('base64'), siblings };
    }
  }
  private encode(kind: Collection, ordinal: number): { item: PublicRunDocumentItem; bytes: Buffer } {
    const item = publicRunDocumentItemSchema.parse({ collection: kind, value: this.source[kind][ordinal] });
    assertPublicProjectionPayloadSafe(item);
    if (item.collection === 'interactionMessages' && (item.value.runId !== this.summary.runId
      || item.value.sessionId !== this.summary.sessionId)) throw new Error('run_document_item_owner_mismatch');
    const bytes = Buffer.from(canonicalPublicProjectionJson(item), 'utf8');
    if (bytes.length > MAX_RUN_DOCUMENT_ITEM_BYTES) throw new Error('run_document_item_too_large');
    return { item, bytes };
  }
  private descriptor(kind: Collection, ordinal: number, info: ItemIndex, chunk: number, bytes: Buffer): PublicRunDocumentLeafDescriptor {
    const content = bytes.subarray(chunk * RUN_DOCUMENT_CHUNK_BYTES, (chunk + 1) * RUN_DOCUMENT_CHUNK_BYTES);
    return { documentContractVersion: RUN_DOCUMENT_VERSION, runId: this.summary.runId,
      runVersion: this.summary.version, collection: kind, itemOrdinal: ordinal, itemId: info.id,
      itemDigest: info.digest, itemMetadataDigest: info.metadataDigest, itemBytes: info.bytes, chunkOrdinal: chunk, chunkCount: info.chunks,
      chunkBytes: content.length, chunkDigest: digest(content), leafIndex: info.firstLeaf + chunk };
  }
}
function digest(value: string | Uint8Array): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
