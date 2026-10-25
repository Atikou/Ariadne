import {
  canonicalPublicProjectionJson, PublicProjectionCatalogPageChain,
  publicProjectionCatalogBeginRequestSchema,
  type PublicProjectionCatalogBeginRequest, type PublicProjectionCatalogPageResult
} from '@ariadne/protocol/public';
import { ProjectionCatalogResetSignal, ProjectionRuntimeClient } from './projection-runtime-client';

export type ProjectionCatalogSelection = Omit<PublicProjectionCatalogBeginRequest, 'pageContractVersion'>;
type CatalogPage = Extract<PublicProjectionCatalogPageResult, { status: 'ok' }>;
export interface ProjectionCatalogWindow {
  readonly page: CatalogPage;
  readonly bytes: number;
}
export type CatalogWindowResult =
  | { readonly status: 'published'; readonly snapshot: ProjectionCatalogWindow }
  | { readonly status: 'superseded' };
export type CatalogScanResult =
  | { readonly status: 'scanned'; readonly cursor: number; readonly digest: string;
      readonly dirty: boolean; readonly hasMore: boolean }
  | { readonly status: 'superseded' };
export interface ProjectionCatalogCapacity {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxRequests: number;
  readonly pageRows: number;
}
const DEFAULT_CAPACITY: ProjectionCatalogCapacity = {
  maxEntries: 8, maxBytes: 4 * 1024 * 1024, maxEntryBytes: 2 * 1024 * 1024,
  maxRequests: 4, pageRows: 128
};
interface CatalogEntry {
  readonly snapshot: ProjectionCatalogWindow;
  readonly chain: PublicProjectionCatalogPageChain;
  cursor: number;
  digest: string;
  dirty: boolean;
}

/** One visible page per selection. Counts describe all matching rows at C;
 * neither page navigation nor a scan builds an application-wide body cache. */
export class ProjectionCatalogRepository {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly tickets = new Map<string, symbol>();
  private readonly navigations = new Map<string, { entry: CatalogEntry; direction: 'next' | 'previous'; operation: Promise<CatalogWindowResult> }>();
  private readonly scans = new Map<string, { entry: CatalogEntry; operation: Promise<CatalogScanResult> }>();
  private readonly listeners = new Set<() => void>();
  private readonly capacity: ProjectionCatalogCapacity;
  private generation = 0;
  private streamId: string | null = null;
  private selectedKey: string | null = null;
  private activeRequests = 0;
  private bytes = 0;

  constructor(private readonly client: ProjectionRuntimeClient, capacity: Partial<ProjectionCatalogCapacity> = {}) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...capacity });
    if (Object.values(this.capacity).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.capacity.maxEntryBytes > this.capacity.maxBytes || this.capacity.maxEntryBytes > 2 * 1024 * 1024
      || this.capacity.pageRows > 256) throw new Error('projection_catalog_capacity_invalid');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  select(selection: ProjectionCatalogSelection): void {
    const key = selectionKey(selection);
    if (key === this.selectedKey) return;
    this.selectedKey = key; this.touch(key); this.publish();
  }
  selected(): ProjectionCatalogWindow | null {
    return this.selectedKey === null ? null : this.entries.get(this.selectedKey)?.snapshot ?? null;
  }
  read(selection: ProjectionCatalogSelection): ProjectionCatalogWindow | null {
    const key = selectionKey(selection); this.touch(key); return this.entries.get(key)?.snapshot ?? null;
  }
  usage(): Readonly<{ entries: number; rows: number; bytes: number; inFlight: number }> {
    return Object.freeze({ entries: this.entries.size, rows: [...this.entries.values()].reduce((sum, entry) => sum + entry.snapshot.page.rows.length, 0),
      bytes: this.bytes, inFlight: this.activeRequests });
  }
  watermark(selection: ProjectionCatalogSelection): Readonly<{ cursor: number; digest: string; dirty: boolean }> | null {
    const entry = this.entries.get(selectionKey(selection));
    return entry === undefined ? null : Object.freeze({ cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty });
  }
  invalidate(): void {
    this.generation += 1; this.entries.clear(); this.tickets.clear(); this.navigations.clear(); this.scans.clear();
    this.bytes = 0; this.streamId = null; this.publish();
  }

  async load(selection: ProjectionCatalogSelection): Promise<CatalogWindowResult> {
    // Parse/copy before the first await; a caller cannot retarget an in-flight request.
    const parsed = publicProjectionCatalogBeginRequestSchema.parse({ ...selection, pageContractVersion: '3.0' });
    const immutableSelection = freeze({ scope: parsed.scope, feature: parsed.feature, filter: parsed.filter });
    const key = selectionKey(immutableSelection);
    this.acquire();
    const ticket = Symbol(key), generation = this.generation;
    this.tickets.set(key, ticket);
    const current = () => generation === this.generation && this.tickets.get(key) === ticket;
    try {
      const manifest = freeze(await this.client.beginCatalog(immutableSelection));
      if (!current()) return { status: 'superseded' };
      const chain = new PublicProjectionCatalogPageChain(manifest);
      const page = await this.fetchPage(chain);
      if (!current()) return { status: 'superseded' };
      if (this.streamId !== null && this.streamId !== manifest.streamId) throw new ProjectionCatalogResetSignal('stream_mismatch');
      const snapshot = this.window(page);
      this.replace(key, { snapshot, chain, cursor: manifest.boundaryCursor, digest: manifest.boundaryDigest, dirty: false });
      this.streamId = manifest.streamId; this.publish();
      return { status: 'published', snapshot };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    } finally {
      this.activeRequests -= 1;
      if (this.tickets.get(key) === ticket) this.tickets.delete(key);
    }
  }

  next(selection: ProjectionCatalogSelection): Promise<CatalogWindowResult> { return this.navigate(selection, 'next'); }
  previous(selection: ProjectionCatalogSelection): Promise<CatalogWindowResult> { return this.navigate(selection, 'previous'); }
  private navigate(selection: ProjectionCatalogSelection, direction: 'next' | 'previous'): Promise<CatalogWindowResult> {
    const key = selectionKey(selection), entry = this.entries.get(key);
    if (entry === undefined) return Promise.reject(new Error('projection_catalog_window_required'));
    const pending = this.navigations.get(key);
    if (pending?.entry === entry && pending.direction === direction) return pending.operation;
    const page = entry.snapshot.page;
    if (direction === 'next' ? !page.hasMore : page.pageIndex === 0) return Promise.resolve({ status: 'published', snapshot: entry.snapshot });
    const operation = this.navigateEntry(key, entry, direction).finally(() => {
      if (this.navigations.get(key)?.operation === operation) this.navigations.delete(key);
    });
    this.navigations.set(key, { entry, direction, operation });
    return operation;
  }
  private async navigateEntry(key: string, entry: CatalogEntry, direction: 'next' | 'previous'): Promise<CatalogWindowResult> {
    this.acquire();
    const ticket = Symbol(key), generation = this.generation;
    this.tickets.set(key, ticket);
    const current = () => generation === this.generation && this.tickets.get(key) === ticket && this.entries.get(key) === entry;
    try {
      const page = entry.snapshot.page;
      // Rewind revalidates the same fixed-C chain while discarding earlier pages.
      // Forward navigation forks accepted state, so failed staging is retryable.
      const chain = direction === 'next' ? entry.chain.fork() : new PublicProjectionCatalogPageChain(page.manifest);
      let result: CatalogPage;
      if (direction === 'next') result = await this.fetchPage(chain, page.nextPageCursor);
      else {
        let continuation: string | undefined;
        let index = 0;
        do {
          result = await this.fetchPage(chain, continuation);
          if (!current()) return { status: 'superseded' };
          continuation = result.nextPageCursor;
        } while (++index < page.pageIndex);
      }
      if (!current()) return { status: 'superseded' };
      const snapshot = this.window(result);
      this.replace(key, { ...entry, snapshot, chain }); this.publish();
      return { status: 'published', snapshot };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    } finally {
      this.activeRequests -= 1;
      if (this.tickets.get(key) === ticket) this.tickets.delete(key);
    }
  }

  scan(selection: ProjectionCatalogSelection): Promise<CatalogScanResult> {
    const key = selectionKey(selection), entry = this.entries.get(key);
    if (entry === undefined) return Promise.reject(new Error('projection_catalog_window_required'));
    const pending = this.scans.get(key);
    if (pending?.entry === entry) return pending.operation;
    const operation = this.scanEntry(key, entry).finally(() => {
      if (this.scans.get(key)?.operation === operation) this.scans.delete(key);
    });
    this.scans.set(key, { entry, operation }); return operation;
  }
  private async scanEntry(key: string, entry: CatalogEntry): Promise<CatalogScanResult> {
    this.acquire();
    const generation = this.generation;
    const current = () => generation === this.generation && this.entries.get(key) === entry;
    try {
      const batch = await this.client.readCatalogCommits({ manifest: entry.snapshot.page.manifest,
        afterCursor: entry.cursor, afterDigest: entry.digest, limit: 128 });
      if (!current()) return { status: 'superseded' };
      if (batch.status !== 'ok') throw new ProjectionCatalogResetSignal(batch.reason);
      entry.dirty ||= batch.entries.some(item => item.changes.length > 0);
      entry.cursor = batch.nextCursor; entry.digest = batch.nextDigest;
      return { status: 'scanned', cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty, hasMore: batch.hasMore };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    } finally { this.activeRequests -= 1; }
  }

  private async fetchPage(chain: PublicProjectionCatalogPageChain, cursor?: string): Promise<CatalogPage> {
    const page = await this.client.readCatalogPage(chain.manifest, cursor, this.capacity.pageRows);
    if (page.status !== 'ok') throw new ProjectionCatalogResetSignal(page.reason);
    const verified = await chain.accept(page);
    if (byteLength(verified) > this.capacity.maxEntryBytes) throw new Error('projection_catalog_entry_byte_limit');
    return freeze(verified);
  }
  private window(page: CatalogPage): ProjectionCatalogWindow { return Object.freeze({ page, bytes: byteLength(page) }); }
  private acquire(): void {
    if (this.activeRequests >= this.capacity.maxRequests) throw new Error('projection_catalog_request_capacity_exceeded');
    this.activeRequests += 1;
  }
  private replace(key: string, entry: CatalogEntry): void {
    const next = new Map(this.entries); next.delete(key); next.set(key, entry);
    let bytes = [...next.values()].reduce((sum, item) => sum + item.snapshot.bytes, 0);
    while (next.size > this.capacity.maxEntries || bytes > this.capacity.maxBytes) {
      const candidate = [...next].find(([entryKey]) => entryKey !== key && entryKey !== this.selectedKey);
      if (candidate === undefined) throw new Error('projection_catalog_pinned_capacity_exceeded');
      next.delete(candidate[0]); bytes -= candidate[1].snapshot.bytes;
    }
    this.entries.clear(); for (const [entryKey, item] of next) this.entries.set(entryKey, item);
    this.bytes = bytes;
  }
  private touch(key: string): void {
    const entry = this.entries.get(key); if (entry === undefined) return;
    this.entries.delete(key); this.entries.set(key, entry);
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
}
function selectionKey(selection: ProjectionCatalogSelection): string {
  const { pageContractVersion: _version, ...value } = publicProjectionCatalogBeginRequestSchema.parse({ ...selection, pageContractVersion: '3.0' });
  return canonicalPublicProjectionJson(value);
}
function byteLength(value: unknown): number { return new TextEncoder().encode(canonicalPublicProjectionJson(value)).byteLength; }
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
