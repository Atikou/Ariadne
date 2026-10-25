import { canonicalPublicProjectionJson, PUBLIC_PROJECTION_GENESIS_DIGEST, publicRunDocumentRootRequestSchema,
  type PublicProjectionCatalogManifest, type PublicRunDocumentRootResult, type PublicRunDocumentMetadataResult,
  type PublicRunDocumentInboxResult, type PublicRunDocumentMetadataProof, type PublicRunDocumentItem } from '@ariadne/protocol/public';
import { ProjectionCatalogResetSignal, ProjectionProtocolIntegrityError, ProjectionRuntimeClient } from './projection-runtime-client';
import { ProjectionBodyRepository, type ProjectionBodyLoadResult, type CompleteProjectionBody } from './projection-body-repository';

type Root = Extract<PublicRunDocumentRootResult, { status: 'ok' }>;
type Page = Extract<PublicRunDocumentMetadataResult, { status: 'ok' }>;
type Inbox = Extract<PublicRunDocumentInboxResult, { status: 'ok' }>;
type Collection = PublicRunDocumentItem['collection'];
export interface ProjectionRunDocumentSnapshot {
  readonly root: Root;
  /** One page per collection. Missing pages and earlier ordinals stay unknown. */
  readonly windows: Readonly<Partial<Record<Collection, Page>>>;
  /** Exact lookups prove only this input at this C, including a verified absence. */
  readonly exactInbox: readonly Inbox[];
}
export type RunDocumentLoadResult =
  | { readonly status: 'published'; readonly snapshot: ProjectionRunDocumentSnapshot }
  | { readonly status: 'unavailable'; readonly reason: 'not_found' | 'deleted' | 'version_mismatch' }
  | { readonly status: 'superseded' };
export interface ProjectionRunDocumentCapacity {
  readonly maxEntries: number; readonly maxBytes: number; readonly maxEntryBytes: number;
  readonly maxRequests: number; readonly maxExactInputs: number;
}
const DEFAULT_CAPACITY: ProjectionRunDocumentCapacity = { maxEntries: 16, maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024, maxRequests: 2, maxExactInputs: 32 };
interface Entry { readonly snapshot: ProjectionRunDocumentSnapshot; readonly bytes: number }

/** Body-free Run ranges. All reads reuse the caller's exact Session/all-Runs C;
 * no global detail, full Run assembly or inferred absence crosses this owner. */
export class ProjectionRunDocumentRepository {
  private readonly capacity: ProjectionRunDocumentCapacity;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<RunDocumentLoadResult>>();
  private readonly tickets = new Map<string, symbol>();
  private readonly pins = new Set<string>();
  private transition: { readonly ticket: symbol; readonly keys: ReadonlySet<string> } | null = null;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private activeRequests = 0;
  private bytes = 0;
  private pinBytes = 0;

  constructor(private readonly client: ProjectionRuntimeClient, readonly bodies: ProjectionBodyRepository,
    capacity: Partial<ProjectionRunDocumentCapacity> = {}) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...capacity });
    if (Object.values(this.capacity).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.capacity.maxEntryBytes > this.capacity.maxBytes) throw new Error('projection_run_document_capacity_invalid');
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  usage(): Readonly<{ entries: number; bytes: number; inFlight: number }> {
    return Object.freeze({ entries: this.entries.size, bytes: this.bytes + this.pinBytes, inFlight: this.activeRequests });
  }
  invalidate(): void {
    this.generation++; this.entries.clear(); this.pending.clear(); this.tickets.clear(); this.pins.clear(); this.transition = null; this.bytes = 0; this.pinBytes = 0; this.publish();
    // Old requests retain physical reservations. Shared bodies belong to their
    // composition owner and are not independently cleared by this range.
  }
  unpin(): void { this.pins.clear(); this.transition = null; this.pinBytes = 0; }
  pin(manifest: PublicProjectionCatalogManifest, runIds: readonly string[]): void {
    const keys = this.pinKeys(manifest, runIds);
    this.reservePins(keys); this.pins.clear(); for (const key of keys) this.pins.add(key); this.transition = null;
  }
  /** Keep the published range pinned until the complete candidate is ready.
   * Both ranges use the same finite byte/entry budget. Superseded candidates
   * cannot release or commit a newer transition's reservation. */
  stagePins(manifest: PublicProjectionCatalogManifest, runIds: readonly string[]): { commit(): boolean; release(): void } {
    const keys = this.pinKeys(manifest, runIds), ticket = Symbol('run-range-transition');
    this.reservePins(new Set([...this.pins, ...keys])); this.transition = { ticket, keys };
    return {
      commit: () => {
        if (this.transition?.ticket !== ticket) return false;
        this.pinBytes = [...keys].reduce((sum, key) => sum + measure(key), 0);
        this.pins.clear(); for (const key of keys) this.pins.add(key); this.transition = null; return true;
      },
      release: () => {
        if (this.transition?.ticket !== ticket) return;
        this.transition = null; this.pinBytes = [...this.pins].reduce((sum, key) => sum + measure(key), 0);
      }
    };
  }
  private pinKeys(manifest: PublicProjectionCatalogManifest, runIds: readonly string[]): Set<string> {
    if (runIds.length > 2 || new Set(runIds).size !== runIds.length) throw new Error('projection_run_document_pin_capacity_exceeded');
    return new Set(runIds.map(id => ownerKey(manifest, id)));
  }
  private reservePins(keys: ReadonlySet<string>): void {
    const pinBytes = [...keys].reduce((sum, key) => sum + measure(key), 0);
    const next = new Map(this.entries); let bytes = this.bytes;
    while (bytes + pinBytes > this.capacity.maxBytes) {
      const victim = [...next].find(([key]) => !keys.has(key));
      if (victim === undefined) throw new Error('projection_run_document_pin_capacity_exceeded');
      next.delete(victim[0]); bytes -= victim[1].bytes;
    }
    this.entries.clear(); for (const [key, entry] of next) this.entries.set(key, entry); this.bytes = bytes;
    this.pinBytes = pinBytes;
  }
  read(manifest: PublicProjectionCatalogManifest, runId: string): ProjectionRunDocumentSnapshot | null {
    const key = ownerKey(manifest, runId), entry = this.entries.get(key);
    if (entry === undefined || !same(entry.snapshot.root.manifest, manifest)) return null;
    this.entries.delete(key); this.entries.set(key, entry); return entry.snapshot;
  }
  load(manifest: PublicProjectionCatalogManifest, runId: string, expectedRunVersion?: number): Promise<RunDocumentLoadResult> {
    const request = freeze(publicRunDocumentRootRequestSchema.parse({ queryContractVersion: '1.0', manifest, runId,
      ...(expectedRunVersion === undefined ? {} : { expectedRunVersion }) }));
    const key = ownerKey(request.manifest, runId);
    return this.request(`root:${key}`, request, async current => {
      const result = await this.client.readRunDocument(request); if (!current()) return { status: 'superseded' };
      if (result.status === 'reset_required') throw new ProjectionCatalogResetSignal(result.reason);
      if (result.status === 'unavailable') return { status: 'unavailable', reason: result.reason };
      const prior = this.entries.get(key)?.snapshot;
      return this.replace(key, prior !== undefined && same(prior.root, result) ? prior
        : { root: result, windows: {}, exactInbox: [] });
    });
  }
  loadCollection(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection): Promise<RunDocumentLoadResult> {
    return this.page(manifest, runId, collection, false);
  }
  nextCollectionPage(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection): Promise<RunDocumentLoadResult> {
    return this.page(manifest, runId, collection, true);
  }
  lookupInbox(manifest: PublicProjectionCatalogManifest, runId: string, inputId: string): Promise<RunDocumentLoadResult> {
    const snapshot = this.require(manifest, runId), root = snapshot.root, key = ownerKey(manifest, runId);
    const request = { queryContractVersion: '1.0', manifest: root.manifest, document: root.document, inputId };
    return this.request(`inbox:${key}:${inputId}`, request, async current => {
      const result = await this.client.readRunDocumentInbox(request);
      if (!current() || !this.currentRoot(key, root)) return { status: 'superseded' };
      if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
      assertRoot(root, result);
      const latest = this.entries.get(key)!.snapshot;
      const exactInbox = [...latest.exactInbox.filter(item => item.inputId !== inputId), result].slice(-this.capacity.maxExactInputs);
      return this.replace(key, { ...latest, exactInbox });
    });
  }
  readBody(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection, itemId: string): CompleteProjectionBody | null {
    return this.bodies.readDocumentItem(this.address(manifest, runId, collection, itemId));
  }
  async loadBody(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection, itemId: string): Promise<ProjectionBodyLoadResult> {
    const address = this.address(manifest, runId, collection, itemId), key = ownerKey(manifest, runId);
    const root = this.require(manifest, runId).root, generation = this.generation;
    try {
      const result = await this.bodies.loadDocumentItem(address);
      if (generation !== this.generation || !this.currentRoot(key, root)) return { status: 'superseded' };
      if (result.status === 'loaded') this.publish(); return result;
    } catch (error) {
      if (generation !== this.generation || !this.currentRoot(key, root)) return { status: 'superseded' }; throw error;
    }
  }
  private page(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection, next: boolean): Promise<RunDocumentLoadResult> {
    const snapshot = this.require(manifest, runId), root = snapshot.root, key = ownerKey(manifest, runId);
    const prior = next ? snapshot.windows[collection] : undefined;
    if (next && (prior === undefined || !prior.hasMore)) return Promise.reject(new Error('projection_run_document_next_page_unavailable'));
    const request = { queryContractVersion: '1.0', manifest: root.manifest, document: root.document, collection, limit: 128,
      ...(prior === undefined ? {} : { pageCursor: prior.nextPageCursor! }) };
    return this.request(`page:${key}:${collection}`, request, async current => {
      const result = await this.client.readRunDocumentMetadata(request);
      if (!current() || !this.currentRoot(key, root)) return { status: 'superseded' };
      if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
      assertRoot(root, result);
      if (result.pageIndex !== (prior === undefined ? 0 : prior.pageIndex + 1)
        || result.startOrdinal !== (prior === undefined ? 0 : prior.startOrdinal + prior.rows.length)
        || result.previousPageDigest !== (prior?.pageDigest ?? PUBLIC_PROJECTION_GENESIS_DIGEST)) {
        throw new ProjectionProtocolIntegrityError('projection_run_document_page_sequence_mismatch');
      }
      const latest = this.entries.get(key)!.snapshot;
      if (prior !== undefined && latest.windows[collection] !== prior) return { status: 'superseded' };
      return this.replace(key, { ...latest, windows: { ...latest.windows, [collection]: result } });
    });
  }
  private require(manifest: PublicProjectionCatalogManifest, runId: string): ProjectionRunDocumentSnapshot {
    const snapshot = this.read(manifest, runId); if (snapshot === null) throw new Error('projection_run_document_root_required'); return snapshot;
  }
  private currentRoot(key: string, root: Root): boolean { return this.entries.get(key)?.snapshot.root === root; }
  private address(manifest: PublicProjectionCatalogManifest, runId: string, collection: Collection, itemId: string) {
    const snapshot = this.require(manifest, runId);
    let proof: PublicRunDocumentMetadataProof | undefined = snapshot.windows[collection]?.rows.find(row => row.descriptor.itemId === itemId);
    if (proof === undefined && collection === 'inbox') proof = snapshot.exactInbox.find(row => row.inputId === itemId)?.proof ?? undefined;
    if (proof === undefined) throw new Error('projection_run_document_item_outside_range');
    return { manifest: snapshot.root.manifest, header: snapshot.root.header, document: snapshot.root.document, proof };
  }
  private request(slot: string, identityValue: unknown, operation: (current: () => boolean) => Promise<RunDocumentLoadResult>): Promise<RunDocumentLoadResult> {
    const identity = `${slot}\0${canonicalPublicProjectionJson(identityValue)}`, pending = this.pending.get(identity);
    if (pending !== undefined) return pending;
    if (this.activeRequests >= this.capacity.maxRequests) return Promise.reject(new Error('projection_run_document_request_capacity_exceeded'));
    const generation = this.generation, ticket = Symbol(slot); this.tickets.set(slot, ticket); this.activeRequests++;
    const current = () => generation === this.generation && this.tickets.get(slot) === ticket;
    const result = Promise.resolve().then(async () => {
      try { return await operation(current); } catch (error) { if (!current()) return { status: 'superseded' } as const; throw error; }
    }).finally(() => {
      this.activeRequests--; if (this.pending.get(identity) === result) this.pending.delete(identity);
      if (this.tickets.get(slot) === ticket) this.tickets.delete(slot);
    });
    this.pending.set(identity, result); return result;
  }
  private replace(key: string, value: ProjectionRunDocumentSnapshot): RunDocumentLoadResult {
    const snapshot = freeze(value), bytes = measure(snapshot) + measure(key);
    if (bytes > this.capacity.maxEntryBytes) throw new Error('projection_run_document_entry_capacity_exceeded');
    const next = new Map(this.entries); next.delete(key); next.set(key, { snapshot, bytes });
    let total = [...next.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (next.size > this.capacity.maxEntries || total + this.pinBytes > this.capacity.maxBytes) {
      const victim = [...next].find(([candidate]) => candidate !== key && !this.pins.has(candidate) && !this.transition?.keys.has(candidate));
      if (victim === undefined) throw new Error('projection_run_document_entry_capacity_exceeded');
      next.delete(victim[0]); total -= victim[1].bytes;
    }
    this.entries.clear(); for (const [candidate, entry] of next) this.entries.set(candidate, entry);
    this.bytes = total; this.publish(); return { status: 'published', snapshot };
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
}
function ownerKey(manifest: PublicProjectionCatalogManifest, runId: string): string {
  const request = publicRunDocumentRootRequestSchema.parse({ queryContractVersion: '1.0', manifest, runId });
  return canonicalPublicProjectionJson({ manifest: request.manifest, runId });
}
function assertRoot(root: Root, result: Page | Inbox): void {
  if (!same(root.manifest, result.manifest) || !same(root.header, result.header) || !same(root.document, result.document)) {
    throw new ProjectionProtocolIntegrityError('projection_run_document_root_binding_mismatch');
  }
}
function same(left: unknown, right: unknown): boolean { return canonicalPublicProjectionJson(left) === canonicalPublicProjectionJson(right); }
function measure(value: unknown): number { return new TextEncoder().encode(canonicalPublicProjectionJson(value)).byteLength; }
function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child); return Object.freeze(value);
}
