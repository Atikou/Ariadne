import { canonicalPublicProjectionJson, messageMetadataOf, publicProjectionCatalogBeginRequestSchema,
  publicProjectionMessageWindowSchema, type PublicProjectionScope, type PublicProjectionMessageWindow,
  type PublicProjectionCatalogManifest, type PublicMessageMetadataWindowResult,
  type PublicConversationInferenceResult, type PublicProjectionFeatureWindow } from '@ariadne/protocol/public';
import { ProjectionCatalogResetSignal, ProjectionRuntimeClient } from './projection-runtime-client';
import { ProjectionBodyRepository, type CompleteProjectionBody, type ProjectionBodyLoadResult } from './projection-body-repository';

type SessionScope = Extract<PublicProjectionScope, { kind: 'session' }>;
type MessageWindow = Extract<PublicMessageMetadataWindowResult, { status: 'ok' }>;
type InferenceWindow = Extract<PublicConversationInferenceResult, { status: 'ok' }>;
export interface ProjectionConversationSnapshot {
  readonly manifest: PublicProjectionCatalogManifest;
  readonly messages: MessageWindow;
  /** Each prefix range retains its own filter and hasEarlier coverage. */
  readonly inferencePrefixes: readonly InferenceWindow[];
  readonly bytes: number;
}
export type ConversationLoadResult =
  | { readonly status: 'published'; readonly snapshot: ProjectionConversationSnapshot }
  | { readonly status: 'anchor_unavailable' | 'superseded' };
export type ConversationScanResult =
  | { readonly status: 'scanned'; readonly cursor: number; readonly digest: string; readonly dirty: boolean; readonly hasMore: boolean }
  | { readonly status: 'superseded' };
export interface ProjectionConversationCapacity {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxRequests: number;
}
const DEFAULT_CAPACITY: ProjectionConversationCapacity = { maxEntries: 3, maxBytes: 24 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024, maxRequests: 3 };
interface Entry { readonly snapshot: ProjectionConversationSnapshot; cursor: number; digest: string; dirty: boolean }

/** Draft conversation owner: one bounded metadata range and its inference
 * prefixes at the same leased C. Complete bodies live in a separate item LRU.
 * Loading a range never implies complete Session history or loads its bodies. */
export class ProjectionConversationRepository {
  readonly bodies: ProjectionBodyRepository;
  private readonly capacity: ProjectionConversationCapacity;
  private readonly entries = new Map<string, Entry>();
  private readonly tickets = new Map<string, symbol>();
  private readonly loads = new Map<string, { identity: string; operation: Promise<ConversationLoadResult> }>();
  private readonly scans = new Map<string, { entry: Entry; operation: Promise<ConversationScanResult> }>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private activeRequests = 0;
  private bytes = 0;
  private streamId: string | null = null;
  private selectedKey: string | null = null;
  constructor(private readonly client: ProjectionRuntimeClient, capacity: Partial<ProjectionConversationCapacity> = {}) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...capacity });
    if (Object.values(this.capacity).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.capacity.maxEntryBytes > this.capacity.maxBytes) throw new Error('projection_conversation_capacity_invalid');
    this.bodies = new ProjectionBodyRepository(client);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  select(scope: SessionScope | null): void {
    const key = scope === null ? null : scopeKey(scope); if (key === this.selectedKey) return;
    const previous = this.selectedKey === null ? undefined : this.entries.get(this.selectedKey);
    if (previous !== undefined) this.bodies.pinMessages(previous.snapshot.manifest, []);
    this.selectedKey = key; if (key !== null) this.touch(key); this.publish();
  }
  selected(): ProjectionConversationSnapshot | null { return this.selectedKey === null ? null : this.entries.get(this.selectedKey)?.snapshot ?? null; }
  read(scope: SessionScope): ProjectionConversationSnapshot | null { const key = scopeKey(scope); this.touch(key); return this.entries.get(key)?.snapshot ?? null; }
  watermark(scope: SessionScope): Readonly<{ cursor: number; digest: string; dirty: boolean }> | null {
    const entry = this.entries.get(scopeKey(scope)); return entry === undefined ? null : Object.freeze({ cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty });
  }
  usage(): Readonly<{ entries: number; bytes: number; inFlight: number; reservedBytes: number }> {
    return Object.freeze({ entries: this.entries.size, bytes: this.bytes, inFlight: this.activeRequests,
      reservedBytes: this.activeRequests * this.capacity.maxEntryBytes });
  }
  invalidate(): void {
    this.generation++; this.entries.clear(); this.tickets.clear(); this.loads.clear(); this.scans.clear();
    this.streamId = null; this.bytes = 0; this.bodies.invalidate(); this.publish();
    // Physical requests retain reservations until finally, including old generations.
  }
  load(scope: SessionScope, window: PublicProjectionMessageWindow = { kind: 'latest', limit: 64 }): Promise<ConversationLoadResult> {
    return this.requestWindow(scope, window);
  }
  /** Navigation reuses the published C, even if newer commits already exist. */
  navigate(scope: SessionScope, window: PublicProjectionMessageWindow): Promise<ConversationLoadResult> {
    const entry = this.entries.get(scopeKey(scope));
    if (entry === undefined) return Promise.reject(new Error('projection_conversation_snapshot_required'));
    return this.requestWindow(scope, window, entry);
  }
  pinBodies(scope: SessionScope, messageIds: readonly string[]): void {
    const key = scopeKey(scope), entry = this.entries.get(key);
    if (entry === undefined || this.selectedKey !== key) throw new Error('projection_conversation_selected_range_required');
    if (new Set(messageIds).size !== messageIds.length) throw new Error('projection_conversation_duplicate_body_id');
    const rows = messageIds.map(id => this.row(entry, id)); this.bodies.pinMessages(entry.snapshot.manifest, rows);
  }
  readBody(scope: SessionScope, messageId: string): CompleteProjectionBody | null {
    const entry = this.entries.get(scopeKey(scope)); if (entry === undefined) return null;
    return this.bodies.readMessage(entry.snapshot.manifest, this.row(entry, messageId));
  }
  async loadBody(scope: SessionScope, messageId: string): Promise<ProjectionBodyLoadResult> {
    const key = scopeKey(scope), entry = this.entries.get(key);
    if (entry === undefined) throw new Error('projection_conversation_snapshot_required');
    const generation = this.generation, row = this.row(entry, messageId);
    try {
      const result = await this.bodies.loadMessage(entry.snapshot.manifest, row);
      if (generation !== this.generation || this.entries.get(key) !== entry) return { status: 'superseded' };
      if (result.status === 'loaded') this.publish(); return result;
    } catch (error) {
      if (generation !== this.generation || this.entries.get(key) !== entry) return { status: 'superseded' };
      throw error;
    }
  }
  scan(scope: SessionScope): Promise<ConversationScanResult> {
    const key = scopeKey(scope), entry = this.entries.get(key);
    if (entry === undefined) return Promise.reject(new Error('projection_conversation_snapshot_required'));
    const pending = this.scans.get(key); if (pending?.entry === entry) return pending.operation;
    this.acquire(); const generation = this.generation, current = () => generation === this.generation && this.entries.get(key) === entry;
    const operation = Promise.resolve().then(async (): Promise<ConversationScanResult> => {
      try {
        const result = await this.client.readConversationReceipts({ queryVersion: '1.0', manifest: entry.snapshot.manifest,
          afterCursor: entry.cursor, afterDigest: entry.digest, limit: 128 });
        if (!current()) return { status: 'superseded' };
        if (result.status !== 'ok') throw new ProjectionCatalogResetSignal(result.reason);
        entry.dirty ||= result.entries.some(item => item.receipts.length > 0);
        entry.cursor = result.nextCursor; entry.digest = result.nextDigest;
        return { status: 'scanned', cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty, hasMore: result.hasMore };
      } catch (error) { if (!current()) return { status: 'superseded' }; throw error; }
    }).finally(() => { this.activeRequests--; if (this.scans.get(key)?.operation === operation) this.scans.delete(key); });
    this.scans.set(key, { entry, operation }); return operation;
  }
  private requestWindow(scopeValue: SessionScope, windowValue: PublicProjectionMessageWindow, prior?: Entry): Promise<ConversationLoadResult> {
    const scope = checkedScope(scopeValue), window = freeze(publicProjectionMessageWindowSchema.parse(windowValue)), key = scopeKey(scope);
    const identity = canonicalPublicProjectionJson({ window, manifest: prior?.snapshot.manifest ?? null });
    const pending = this.loads.get(key); if (pending?.identity === identity) return pending.operation;
    this.acquire(); const generation = this.generation, ticket = Symbol(key); this.tickets.set(key, ticket);
    const current = () => generation === this.generation && this.tickets.get(key) === ticket
      && (prior === undefined || this.entries.get(key) === prior);
    const operation = Promise.resolve().then(async (): Promise<ConversationLoadResult> => {
      try {
        const manifest = prior?.snapshot.manifest ?? await this.client.beginCatalog({ scope, feature: 'runs', filter: 'all' });
        if (!current()) return { status: 'superseded' };
        const messages = await this.client.readMessageMetadataWindow({ queryContractVersion: '1.0', manifest, window });
        if (!current()) return { status: 'superseded' };
        if (messages.status === 'reset_required') throw new ProjectionCatalogResetSignal(messages.reason);
        if (messages.status === 'anchor_unavailable') return { status: 'anchor_unavailable' };
        if (measure({ manifest, messages }) + utf8Bytes(key) + 512 > this.capacity.maxEntryBytes) throw new Error('projection_conversation_entry_capacity_exceeded');
        const runIds = [...new Set(messages.rows.flatMap(row => { const id = messageMetadataOf(row).runId; return id === undefined ? [] : [id]; }))];
        const descriptors: PublicProjectionFeatureWindow[] = [{ feature: 'inference_streams', filter: 'streaming', limit: 128 },
          ...(runIds.length === 0 ? [] : [{ feature: 'inference_streams' as const, filter: 'all' as const, limit: 128, runIds }])];
        const inferencePrefixes: InferenceWindow[] = [];
        for (const descriptor of descriptors) {
          const result = await this.client.readConversationInferenceWindow({ queryVersion: '1.0', manifest, window: descriptor });
          if (!current()) return { status: 'superseded' };
          if (result.status === 'reset_required') throw new ProjectionCatalogResetSignal(result.reason);
          if (result.status !== 'ok') throw new Error('projection_conversation_unanchored_prefix_unavailable');
          inferencePrefixes.push(result);
          if (measure({ manifest, messages, inferencePrefixes }) > this.capacity.maxEntryBytes) throw new Error('projection_conversation_entry_capacity_exceeded');
        }
        if (this.streamId !== null && this.streamId !== manifest.streamId) throw new ProjectionCatalogResetSignal('stream_mismatch');
        const payload = { manifest, messages, inferencePrefixes }, bytes = measure(payload) + utf8Bytes(key) + 512;
        if (bytes > this.capacity.maxEntryBytes) throw new Error('projection_conversation_entry_capacity_exceeded');
        const snapshot = freeze({ ...payload, bytes });
        this.replace(key, { snapshot, cursor: manifest.boundaryCursor, digest: manifest.boundaryDigest, dirty: false });
        this.streamId = manifest.streamId; this.publish(); return { status: 'published', snapshot };
      } catch (error) { if (!current()) return { status: 'superseded' }; throw error; }
    }).finally(() => {
      this.activeRequests--; if (this.tickets.get(key) === ticket) this.tickets.delete(key);
      if (this.loads.get(key)?.operation === operation) this.loads.delete(key);
    });
    this.loads.set(key, { identity, operation }); return operation;
  }
  private row(entry: Entry, id: string) {
    const row = entry.snapshot.messages.rows.find(value => messageMetadataOf(value).messageId === id);
    if (row === undefined) throw new Error('projection_conversation_body_outside_range'); return row;
  }
  private acquire(): void {
    if (this.activeRequests >= this.capacity.maxRequests) throw new Error('projection_conversation_request_capacity_exceeded');
    this.activeRequests++;
  }
  private replace(key: string, entry: Entry): void {
    const next = new Map(this.entries); next.delete(key); next.set(key, entry);
    let bytes = [...next.values()].reduce((sum, value) => sum + value.snapshot.bytes, 0);
    while (next.size > this.capacity.maxEntries || bytes > this.capacity.maxBytes) {
      const victim = [...next].find(([candidate]) => candidate !== key && candidate !== this.selectedKey);
      if (victim === undefined) throw new Error('projection_conversation_cache_capacity_exceeded');
      next.delete(victim[0]); bytes -= victim[1].snapshot.bytes;
    }
    const previous = this.entries.get(key);
    if (key === this.selectedKey && previous !== undefined) this.bodies.pinMessages(previous.snapshot.manifest, []);
    this.entries.clear(); for (const [candidate, value] of next) this.entries.set(candidate, value); this.bytes = bytes;
  }
  private touch(key: string): void { const entry = this.entries.get(key); if (entry !== undefined) { this.entries.delete(key); this.entries.set(key, entry); } }
  private publish(): void { for (const listener of this.listeners) listener(); }
}
function checkedScope(value: SessionScope): SessionScope {
  const parsed = publicProjectionCatalogBeginRequestSchema.parse({ pageContractVersion: '3.0', scope: value, feature: 'runs', filter: 'all' });
  if (parsed.scope.kind !== 'session') throw new Error('projection_conversation_session_required'); return freeze(parsed.scope);
}
function scopeKey(scope: SessionScope): string { return canonicalPublicProjectionJson(checkedScope(scope)); }
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function measure(value: unknown): number { return utf8Bytes(canonicalPublicProjectionJson(value)); }
function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child); return Object.freeze(value);
}
