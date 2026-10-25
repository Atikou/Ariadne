import {
  canonicalPublicProjectionJson,
  publicProjectionViewBeginRequestSchema, publicProjectionMessageWindowSchema,
  publicProjectionFeatureReceiptManifestSchema,
  type PublicProjectionFeature, type PublicProjectionMessageWindow, type PublicProjectionScope
} from '@ariadne/protocol/public';
import type { PublicProjectionFeatureWindow } from '@ariadne/protocol/public';
import { ProjectionRuntimeClient, ProjectionSnapshotResetSignal, ProjectionScopedReadResetSignal } from './projection-runtime-client';
import { ProjectionScopeStaging, type ProjectionScopeSnapshot } from './projection-scope-staging';

export interface ProjectionScopeCapacity {
  readonly maxEntries: number;
  readonly maxSessionEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}
const DEFAULT_CAPACITY: ProjectionScopeCapacity = {
  maxEntries: 8, maxSessionEntries: 3, maxBytes: 24 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024
};
interface CacheEntry {
  readonly snapshot: ProjectionScopeSnapshot;
  readonly session: boolean;
  cursor: number;
  digest: string;
  dirty: boolean;
}
export type ScopeLoadResult =
  | { readonly status: 'published'; readonly key: string; readonly snapshot: ProjectionScopeSnapshot }
  | { readonly status: 'superseded' };
export type ScopeScanResult =
  | { readonly status: 'scanned'; readonly cursor: number; readonly digest: string;
      readonly dirty: boolean; readonly hasMore: boolean }
  | { readonly status: 'superseded' };

/** Read-only, bounded view ownership. Request tickets fence lifecycle and per-scope replacements. */
export class ProjectionScopeRepository {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly requests = new Map<string, symbol>();
  private readonly scans = new Map<string, Promise<ScopeScanResult>>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private streamId: string | null = null;
  private selectedKey: string | null = null;
  private bytes = 0;
  private activeLoads = 0;
  private readonly capacity: ProjectionScopeCapacity;

  constructor(private readonly client: ProjectionRuntimeClient, capacity: Partial<ProjectionScopeCapacity> = {}) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...capacity });
    for (const value of Object.values(this.capacity)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('projection_scope_cache_capacity_invalid');
    }
    if (this.capacity.maxEntryBytes > this.capacity.maxBytes
      || this.capacity.maxSessionEntries > this.capacity.maxEntries) throw new Error('projection_scope_cache_capacity_invalid');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[]): void {
    const next = scopeKey(scope, features);
    if (this.selectedKey === next) return;
    this.selectedKey = next;
    this.touch(next);
    this.publish();
  }

  selected(): ProjectionScopeSnapshot | null {
    return this.selectedKey === null ? null : this.entries.get(this.selectedKey)?.snapshot ?? null;
  }

  read(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[]): ProjectionScopeSnapshot | null {
    const key = scopeKey(scope, features);
    this.touch(key);
    return this.entries.get(key)?.snapshot ?? null;
  }

  usage(): Readonly<{ entries: number; sessions: number; bytes: number; inFlight: number }> {
    return Object.freeze({ entries: this.entries.size, sessions: this.sessionCount(),
      bytes: this.bytes, inFlight: this.activeLoads });
  }

  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
    this.requests.clear();
    this.scans.clear();
    this.streamId = null;
    this.bytes = 0;
    this.publish();
  }

  scan(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[]): Promise<ScopeScanResult> {
    const key = scopeKey(scope, features);
    const pending = this.scans.get(key);
    if (pending !== undefined) return pending;
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.reject(new Error('projection_scope_scan_snapshot_required'));
    const operation = this.scanEntry(key, entry).finally(() => {
      if (this.scans.get(key) === operation) this.scans.delete(key);
    });
    this.scans.set(key, operation);
    return operation;
  }

  watermark(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[]):
    Readonly<{ cursor: number; digest: string; dirty: boolean }> | null {
    const entry = this.entries.get(scopeKey(scope, features));
    return entry === undefined ? null : Object.freeze({ cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty });
  }

  private async scanEntry(key: string, entry: CacheEntry): Promise<ScopeScanResult> {
    const generation = this.generation;
    const current = () => generation === this.generation && this.entries.get(key) === entry;
    try {
      const receiptManifest = publicProjectionFeatureReceiptManifestSchema.safeParse(entry.snapshot.manifest);
      // Message windows have additional Message/Run dependencies. Their scan
      // cannot be replaced by a feature-only subscription until those ranges
      // have their own continuous invalidation query.
      if (entry.snapshot.messageWindow === null && receiptManifest.success) {
        const batch = await this.client.readFeatureReceipts({ queryVersion: '1.0', manifest: receiptManifest.data,
          afterCursor: entry.cursor, afterDigest: entry.digest, limit: 128 });
        if (!current()) return { status: 'superseded' };
        if (batch.status !== 'ok') {
          if (batch.reason === 'cursor_gap' || batch.reason === 'history_mismatch') throw new ProjectionScopedReadResetSignal(batch.reason);
          throw new ProjectionSnapshotResetSignal(batch.reason);
        }
        entry.dirty ||= batch.entries.some(item => item.receipts.length > 0);
        entry.cursor = batch.nextCursor; entry.digest = batch.nextDigest;
        return { status: 'scanned', cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty, hasMore: batch.hasMore };
      }
      const batch = await this.client.readScopedCommits({ readContractVersion: '1.0',
        scope: entry.snapshot.manifest.scope, streamId: entry.snapshot.manifest.streamId,
        afterCursor: entry.cursor, afterDigest: entry.digest, limit: 128 });
      if (!current()) return { status: 'superseded' };
      if (batch.status !== 'ok') throw new ProjectionScopedReadResetSignal(batch.reason);
      const selected = entry.snapshot.manifest.selectedFeatures;
      // Bodies remain inside the bounded response. Visible entities are replaced
      // only by a complete fixed-C staging; a dirty view retains its prior C.
      entry.dirty ||= batch.entries.some(item => item.changes.some(change => selected.includes(change.feature)
        || (entry.session && (change.feature === 'messages' || change.feature === 'runs'))));
      entry.cursor = batch.nextCursor;
      entry.digest = batch.nextDigest;
      return { status: 'scanned', cursor: entry.cursor, digest: entry.digest, dirty: entry.dirty, hasMore: batch.hasMore };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    }
  }

  load(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[], window?: PublicProjectionMessageWindow): Promise<ScopeLoadResult> {
    return this.loadView(scope, features, window, false);
  }

  /** Production visible ranges: full history is never a metadata prerequisite. */
  loadBounded(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[], window?: PublicProjectionMessageWindow): Promise<ScopeLoadResult> {
    if (features.some(feature => !['models', 'diagnostics', 'inference_streams'].includes(feature))) {
      return Promise.reject(new Error('projection_scope_bounded_feature_invalid'));
    }
    return this.loadView(scope, features, window, true);
  }

  private async loadView(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[],
    window: PublicProjectionMessageWindow | undefined, bounded: boolean): Promise<ScopeLoadResult> {
    if ((scope.kind === 'session') !== (window !== undefined)) throw new Error('projection_scope_cache_window_owner_invalid');
    publicProjectionViewBeginRequestSchema.parse({ pageContractVersion: '2.0', scope, features });
    if (window !== undefined) publicProjectionMessageWindowSchema.parse(window);
    scope = Object.freeze({ ...scope });
    features = Object.freeze([...features]);
    if (window !== undefined) window = Object.freeze({ ...window });
    const key = scopeKey(scope, features);
    if (this.activeLoads >= this.capacity.maxEntries) {
      throw new Error('projection_scope_cache_request_capacity_exceeded');
    }
    this.activeLoads += 1;
    const ticket = Symbol(key);
    const generation = this.generation;
    this.requests.set(key, ticket);
    const current = () => generation === this.generation && this.requests.get(key) === ticket;
    try {
      const manifest = await this.client.beginViewSnapshot(scope, features);
      if (!current()) return { status: 'superseded' };
      const staging = new ProjectionScopeStaging(manifest, this.capacity.maxEntryBytes);
      if (bounded) {
        if (window !== undefined) {
          const result = await this.client.readMessageWindow(manifest, window);
          if (!current()) return { status: 'superseded' };
          await staging.addWindow(window, result);
          if (!current()) return { status: 'superseded' };
          const runIds = result.status === 'ok' ? [...new Set(result.changes.flatMap(change =>
            change.feature === 'messages' && change.dto?.runId !== undefined ? [change.dto.runId] : []))] : [];
          const descriptors: PublicProjectionFeatureWindow[] = [{ feature: 'inference_streams', filter: 'streaming', limit: 128 },
            ...(runIds.length > 0 ? [{ feature: 'inference_streams' as const, filter: 'all' as const, limit: 128, runIds }] : [])];
          staging.expectFeatureWindows(descriptors);
          for (const descriptor of descriptors) {
            const result = await this.client.readFeatureWindow(manifest, descriptor);
            if (!current()) return { status: 'superseded' };
            await staging.addFeatureWindow(descriptor, result);
            if (!current()) return { status: 'superseded' };
          }
        } else {
          const descriptors: PublicProjectionFeatureWindow[] = features.map(feature => ({
            feature: feature as 'models' | 'diagnostics', filter: 'all', limit: 128 }));
          staging.expectFeatureWindows(descriptors);
          for (const descriptor of descriptors) {
            const result = await this.client.readFeatureWindow(manifest, descriptor);
            if (!current()) return { status: 'superseded' };
            await staging.addFeatureWindow(descriptor, result);
            if (!current()) return { status: 'superseded' };
          }
        }
      } else {
      let cursor: string | undefined;
      let count = 0;
      do {
        if (++count > 100_000) throw new Error('projection_scope_page_limit');
        const page = await this.client.readViewPage(manifest, cursor);
        if (!current()) return { status: 'superseded' };
        await staging.addPage(page);
        if (!current()) return { status: 'superseded' };
        cursor = page.status === 'ok' ? page.nextPageCursor ?? undefined : undefined;
      } while (cursor !== undefined);
      if (window !== undefined) {
        const result = await this.client.readMessageWindow(manifest, window);
        if (!current()) return { status: 'superseded' };
        await staging.addWindow(window, result);
        if (!current()) return { status: 'superseded' };
      }
      }
      const snapshot = staging.finish();
      if (this.streamId !== null && this.streamId !== manifest.streamId) {
        // Only a lifecycle reset can authorize a new stream. Concurrent old requests
        // must never switch the repository back to a departed Runtime generation.
        throw new ProjectionSnapshotResetSignal('stream_mismatch');
      }
      this.replace(key, snapshot);
      this.streamId = manifest.streamId;
      this.publish();
      return { status: 'published', key, snapshot };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    } finally {
      this.activeLoads -= 1;
      if (this.requests.get(key) === ticket) this.requests.delete(key);
    }
  }

  private replace(key: string, snapshot: ProjectionScopeSnapshot): void {
    const next = new Map(this.entries);
    next.delete(key);
    next.set(key, { snapshot, session: snapshot.manifest.scope.kind === 'session',
      cursor: snapshot.manifest.boundaryCursor, digest: snapshot.manifest.boundaryDigest, dirty: false });
    let bytes = [...next.values()].reduce((sum, entry) => sum + entry.snapshot.bytes, 0);
    let sessions = [...next.values()].filter(entry => entry.session).length;
    while (next.size > this.capacity.maxEntries || sessions > this.capacity.maxSessionEntries
      || bytes > this.capacity.maxBytes) {
      const candidate = [...next].find(([entryKey, entry]) => entryKey !== key
        && entryKey !== this.selectedKey
        && (sessions <= this.capacity.maxSessionEntries || entry.session));
      if (candidate === undefined) throw new Error('projection_scope_cache_pinned_capacity_exceeded');
      next.delete(candidate[0]);
      bytes -= candidate[1].snapshot.bytes;
      if (candidate[1].session) sessions -= 1;
    }
    this.entries.clear();
    for (const [entryKey, entry] of next) this.entries.set(entryKey, entry);
    this.bytes = bytes;
  }

  private touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  private sessionCount(): number { return [...this.entries.values()].filter(entry => entry.session).length; }
  private publish(): void { for (const listener of this.listeners) listener(); }
}

function scopeKey(scope: PublicProjectionScope, features: readonly PublicProjectionFeature[]): string {
  publicProjectionViewBeginRequestSchema.parse({ pageContractVersion: '2.0', scope, features });
  return canonicalPublicProjectionJson({ scope, features });
}
