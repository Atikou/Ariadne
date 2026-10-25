import { canonicalPublicProjectionJson, MAX_RUN_DOCUMENT_ITEM_BYTES, messageMetadataOf,
  publicMessageMetadataRowSchema, publicRunDocumentChunkRequestSchema, publicRunDocumentHeaderSchema,
  publicRunDocumentMetadataProofSchema, RunDocumentItemAssembler, runDocumentItemMetadata,
  verifyMessageMetadataRow, verifyRunDocumentItemMetadata, type PublicMessageProjection,
  type PublicMessageMetadataRow, type PublicProjectionCatalogManifest, type PublicRunDocumentHeader,
  type PublicRunDocumentReference, type PublicRunDocumentMetadataProof, type PublicRunDocumentItem } from '@ariadne/protocol/public';
import { ProjectionCatalogResetSignal, ProjectionProtocolIntegrityError, ProjectionRuntimeClient } from './projection-runtime-client';
import { PublicResultError } from '../public-result';

export interface ProjectionDocumentItemAddress {
  readonly manifest: PublicProjectionCatalogManifest;
  readonly header: PublicRunDocumentHeader;
  readonly document: PublicRunDocumentReference;
  readonly proof: PublicRunDocumentMetadataProof;
}
export type CompleteProjectionBody =
  | { readonly kind: 'message'; readonly message: PublicMessageProjection }
  | { readonly kind: 'document_item'; readonly item: PublicRunDocumentItem };
export type ProjectionBodyLoadResult =
  | { readonly status: 'loaded'; readonly body: CompleteProjectionBody }
  | { readonly status: 'superseded' };
export interface ProjectionBodyCapacity {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxItemBytes: number;
  readonly maxRequests: number;
  readonly maxInFlightBytes: number;
}
const DEFAULT_CAPACITY: ProjectionBodyCapacity = { maxEntries: 32, maxBytes: 16 * 1024 * 1024,
  maxItemBytes: MAX_RUN_DOCUMENT_ITEM_BYTES, maxRequests: 2, maxInFlightBytes: 16 * 1024 * 1024 };
interface Entry { readonly body: CompleteProjectionBody; readonly bytes: number }

/** Complete single items only. Exact leased addresses bind cache identities;
 * no complete Run is assembled and partial bytes never enter published state. */
export class ProjectionBodyRepository {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<ProjectionBodyLoadResult>>();
  private readonly pins = new Set<string>();
  private readonly capacity: ProjectionBodyCapacity;
  private generation = 0;
  private bytes = 0;
  private pinBytes = 0;
  private activeRequests = 0;
  private inFlightBytes = 0;

  constructor(private readonly client: ProjectionRuntimeClient, capacity: Partial<ProjectionBodyCapacity> = {}) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...capacity });
    if (Object.values(this.capacity).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.capacity.maxItemBytes > MAX_RUN_DOCUMENT_ITEM_BYTES || this.capacity.maxItemBytes > this.capacity.maxBytes
      || this.capacity.maxItemBytes > this.capacity.maxInFlightBytes) throw new Error('projection_body_capacity_invalid');
  }

  usage(): Readonly<{ entries: number; bytes: number; inFlight: number; inFlightBytes: number; pinned: number }> {
    return Object.freeze({ entries: this.entries.size, bytes: this.bytes + this.pinBytes, inFlight: this.activeRequests,
      inFlightBytes: this.inFlightBytes, pinned: this.pins.size });
  }
  invalidate(): void {
    this.generation++; this.entries.clear(); this.pending.clear(); this.pins.clear(); this.bytes = 0; this.pinBytes = 0;
    // Already dispatched requests retain their physical reservations until they
    // settle. Late generations cannot issue more requests by clearing a map.
  }
  pinMessages(manifest: PublicProjectionCatalogManifest, rows: readonly PublicMessageMetadataRow[]): void {
    if (rows.length > this.capacity.maxEntries) throw new Error('projection_body_pin_capacity_exceeded');
    const keys = new Set(rows.map(row => this.messageAddress(manifest, row).key)), pinBytes = [...keys].reduce((sum, key) => sum + utf8Bytes(key), 0);
    const next = new Map(this.entries); let bytes = this.bytes;
    while (bytes + pinBytes > this.capacity.maxBytes) {
      const victim = [...next].find(([key]) => !keys.has(key));
      if (victim === undefined) throw new Error('projection_body_pin_capacity_exceeded');
      next.delete(victim[0]); bytes -= victim[1].bytes;
    }
    this.entries.clear(); for (const [key, entry] of next) this.entries.set(key, entry); this.bytes = bytes;
    this.pins.clear(); for (const key of keys) this.pins.add(key); this.pinBytes = pinBytes;
  }
  readMessage(manifest: PublicProjectionCatalogManifest, row: PublicMessageMetadataRow): CompleteProjectionBody | null {
    return this.read(this.messageAddress(manifest, row).key);
  }
  loadMessage(manifest: PublicProjectionCatalogManifest, value: PublicMessageMetadataRow): Promise<ProjectionBodyLoadResult> {
    const address = this.messageAddress(manifest, value), row = address.row;
    return this.load(address.key, row.kind === 'message' ? 1024 * 1024 : row.proof.descriptor.itemBytes, async current => {
      await verifyMessageMetadataRow(row); if (!current()) return null;
      if (row.kind === 'run_document') return this.documentBody(address.manifest, row.header, row.document, row.proof, current);
      const result = await this.client.readMessageBody({ queryContractVersion: '1.0', manifest: address.manifest, body: row.body });
      if (!current()) return null;
      if (result.status === 'reset_required') throw new ProjectionCatalogResetSignal(result.reason);
      if (result.status !== 'ok') throw new ProjectionProtocolIntegrityError('projection_body_declared_message_unavailable');
      if (canonicalPublicProjectionJson(runDocumentItemMetadata({ collection: 'interactionMessages', value: result.message }).value)
        !== canonicalPublicProjectionJson(row.metadata)) throw new ProjectionProtocolIntegrityError('projection_body_message_metadata_mismatch');
      return { kind: 'message', message: result.message };
    });
  }
  readDocumentItem(address: ProjectionDocumentItemAddress): CompleteProjectionBody | null {
    return this.read(this.documentAddress(address).key);
  }
  loadDocumentItem(value: ProjectionDocumentItemAddress): Promise<ProjectionBodyLoadResult> {
    const address = this.documentAddress(value);
    return this.load(address.key, address.proof.descriptor.itemBytes, async current => {
      await verifyRunDocumentItemMetadata(address.header, address.proof.descriptor, address.proof.siblings, address.proof.metadata);
      if (!current()) return null;
      return this.documentBody(address.manifest, address.header, address.document, address.proof, current);
    });
  }

  private messageAddress(manifestValue: PublicProjectionCatalogManifest, value: PublicMessageMetadataRow) {
    const row = publicMessageMetadataRowSchema.parse(value);
    // The root request schema's manifest restriction is shared by the chunk
    // request, so Message and document addresses have one exact Session/C.
    const manifest = this.checkedManifest(manifestValue);
    const metadata = messageMetadataOf(row);
    const versionCursor = row.kind === 'message' ? row.body.versionCommitCursor : row.document.versionCommitCursor;
    if (manifest.scope.kind !== 'session' || metadata.sessionId !== manifest.scope.sessionId || versionCursor > manifest.boundaryCursor
      || (row.kind === 'run_document' && row.header.summary.sessionId !== metadata.sessionId)) throw new ProjectionProtocolIntegrityError('projection_body_owner_mismatch');
    const documentKey = row.kind === 'run_document'
      ? this.documentAddress({ manifest, header: row.header, document: row.document, proof: row.proof }).key : null;
    const frozen = freeze(structuredClone({ manifest, row }));
    return { ...frozen, key: documentKey ?? `message\0${canonicalPublicProjectionJson(frozen)}` };
  }
  private checkedManifest(value: PublicProjectionCatalogManifest) {
    // Validate only the shared exact-Session Run manifest, without fabricating
    // a snapshot or a View-2 descriptor at another boundary.
    return publicRunDocumentChunkRequestSchema.shape.manifest.parse(value);
  }
  private documentAddress(value: ProjectionDocumentItemAddress) {
    const header = publicRunDocumentHeaderSchema.parse(value.header), proof = publicRunDocumentMetadataProofSchema.parse(value.proof);
    const request = publicRunDocumentChunkRequestSchema.parse({ queryContractVersion: '1.0', manifest: value.manifest,
      document: value.document, collection: proof.descriptor.collection, itemOrdinal: proof.descriptor.itemOrdinal, chunkOrdinal: 0 });
    if (request.manifest.scope.kind !== 'session' || header.summary.sessionId !== request.manifest.scope.sessionId
      || header.summary.runId !== request.document.runId || header.summary.version !== request.document.runVersion
      || header.documentDigest !== request.document.documentDigest || request.document.versionCommitCursor > request.manifest.boundaryCursor
      || proof.descriptor.chunkOrdinal !== 0) throw new ProjectionProtocolIntegrityError('projection_body_document_binding_mismatch');
    const frozen = freeze(structuredClone({ manifest: request.manifest, document: request.document, header, proof }));
    return { ...frozen, key: `document_item\0${canonicalPublicProjectionJson(frozen)}` };
  }
  private async documentBody(manifest: PublicProjectionCatalogManifest, header: PublicRunDocumentHeader,
    document: PublicRunDocumentReference, proof: PublicRunDocumentMetadataProof, current: () => boolean): Promise<CompleteProjectionBody | null> {
    const descriptor = proof.descriptor, assembler = new RunDocumentItemAssembler(header, descriptor.collection, descriptor.itemOrdinal);
    let item: PublicRunDocumentItem | null = null;
    for (let ordinal = 0; ordinal < descriptor.chunkCount; ordinal++) {
      if (!current()) return null;
      const result = await this.client.readRunDocumentChunk({ queryContractVersion: '1.0', manifest, document,
        collection: descriptor.collection, itemOrdinal: descriptor.itemOrdinal, chunkOrdinal: ordinal });
      if (!current()) return null;
      if (result.status === 'reset_required') throw new ProjectionCatalogResetSignal(result.reason);
      if (result.status !== 'ok') throw new ProjectionProtocolIntegrityError('projection_body_declared_chunk_unavailable');
      item = await assembler.accept(result.leaf); if (!current()) return null;
    }
    if (item === null || canonicalPublicProjectionJson(runDocumentItemMetadata(item)) !== canonicalPublicProjectionJson(proof.metadata)) {
      throw new ProjectionProtocolIntegrityError('projection_body_document_metadata_mismatch');
    }
    return { kind: 'document_item', item };
  }
  private read(key: string): CompleteProjectionBody | null {
    const entry = this.entries.get(key); if (entry === undefined) return null;
    this.entries.delete(key); this.entries.set(key, entry); return entry.body;
  }
  private load(key: string, reservation: number, readBody: (current: () => boolean) => Promise<CompleteProjectionBody | null>): Promise<ProjectionBodyLoadResult> {
    const cached = this.read(key); if (cached !== null) return Promise.resolve({ status: 'loaded', body: cached });
    const pending = this.pending.get(key); if (pending !== undefined) return pending;
    if (reservation > this.capacity.maxItemBytes) return Promise.reject(new Error('projection_body_item_capacity_exceeded'));
    if (this.activeRequests >= this.capacity.maxRequests || this.inFlightBytes + reservation > this.capacity.maxInFlightBytes) {
      return Promise.reject(new Error('projection_body_request_capacity_exceeded'));
    }
    const generation = this.generation, current = () => generation === this.generation;
    this.activeRequests++; this.inFlightBytes += reservation;
    const operation = Promise.resolve().then(async (): Promise<ProjectionBodyLoadResult> => {
      try {
        const fetched = await readBody(current); if (!current() || fetched === null) return { status: 'superseded' };
        const body = freeze(fetched), bytes = measure(body) + utf8Bytes(key);
        this.replace(key, { body, bytes }); return { status: 'loaded', body };
      } catch (error) {
        if (!current()) return { status: 'superseded' };
        if (error instanceof PublicResultError || error instanceof ProjectionCatalogResetSignal || error instanceof ProjectionProtocolIntegrityError
          || (error instanceof Error && error.message.startsWith('projection_body_') && error.message.includes('capacity'))) throw error;
        throw new ProjectionProtocolIntegrityError(code(error));
      }
    }).finally(() => {
      this.activeRequests--; this.inFlightBytes -= reservation;
      if (this.pending.get(key) === operation) this.pending.delete(key);
    });
    this.pending.set(key, operation); return operation;
  }
  private replace(key: string, entry: Entry): void {
    const next = new Map(this.entries); next.delete(key); next.set(key, entry);
    let bytes = [...next.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (next.size > this.capacity.maxEntries || bytes + this.pinBytes > this.capacity.maxBytes) {
      const victim = [...next].find(([candidate]) => candidate !== key && !this.pins.has(candidate));
      if (victim === undefined) throw new Error('projection_body_pinned_capacity_exceeded');
      next.delete(victim[0]); bytes -= victim[1].bytes;
    }
    this.entries.clear(); for (const [candidate, item] of next) this.entries.set(candidate, item); this.bytes = bytes;
  }
}
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function measure(value: unknown): number { return utf8Bytes(canonicalPublicProjectionJson(value)); }
function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child); return Object.freeze(value);
}
function code(error: unknown): string { return (error instanceof Error ? error.message : 'unknown').replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 512); }
