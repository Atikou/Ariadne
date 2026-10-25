import {
  PublicProjectionViewPageChain, canonicalPublicProjectionJson, publicProjectionViewManifestSchema,
  verifyPublicProjectionMessageWindow,
  type PublicProjectionChange, type PublicProjectionViewManifest,
  type PublicProjectionViewPageResult, type PublicProjectionMessageWindow,
  type PublicProjectionMessageWindowResult, type PublicProjectionMessageWindowOk
} from '@ariadne/protocol/public';
import { ProjectionProtocolIntegrityError, ProjectionSnapshotResetSignal } from './projection-runtime-client';
import { verifyPublicProjectionFeatureWindow, publicProjectionFeatureWindowRequestSchema,
  type PublicProjectionFeatureWindow, type PublicProjectionFeatureWindowResult, type PublicProjectionFeatureWindowOk } from '@ariadne/protocol/public';

export interface ProjectionScopeSnapshot {
  readonly manifest: PublicProjectionViewManifest;
  readonly changes: readonly PublicProjectionChange[];
  readonly messageWindow: PublicProjectionMessageWindowOk | null;
  readonly featureWindows: readonly Pick<PublicProjectionFeatureWindowOk, 'window' | 'hasEarlier'>[];
  readonly bytes: number;
}

/** Nothing in this staging object is observable through the visible feature stores. */
export class ProjectionScopeStaging {
  readonly manifest: PublicProjectionViewManifest;
  private readonly chain: PublicProjectionViewPageChain;
  private readonly rows: PublicProjectionChange[] = [];
  private metadataComplete = false;
  private window: PublicProjectionMessageWindowOk | null = null;
  private bytes = 0;
  private sealed: ProjectionScopeSnapshot | null = null;
  private nextIndex = 0;
  private pendingFeatureWindows: Set<string> | null = null;
  private readonly featureWindows: Pick<PublicProjectionFeatureWindowOk, 'window' | 'hasEarlier'>[] = [];

  constructor(manifest: unknown, private readonly maxBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('projection_scope_staging_capacity_invalid');
    this.manifest = freeze(publicProjectionViewManifestSchema.parse(manifest));
    if (this.manifest.scope.kind === 'session' && this.manifest.selectedFeatures.includes('messages')) {
      throw new Error('projection_scope_message_window_selection_required');
    }
    this.chain = new PublicProjectionViewPageChain(this.manifest);
  }

  async addPage(value: PublicProjectionViewPageResult): Promise<void> {
    this.assertOpen();
    if (this.pendingFeatureWindows !== null) throw new Error('projection_scope_metadata_mode_mismatch');
    if (value.status === 'reset_required') throw new ProjectionSnapshotResetSignal(value.reason);
    try {
      const page = await this.chain.accept(value);
      this.assertOpen();
      if (page.pageIndex !== this.nextIndex) throw new Error('projection_scope_staging_page_order');
      const bytes = this.measure(page.changes);
      if (this.bytes + bytes > this.maxBytes) throw new Error('projection_scope_staging_capacity_exceeded');
      this.rows.push(...page.changes.map(change => freeze(change)));
      this.bytes += bytes;
      this.nextIndex += 1;
      // This flag is set only after this object's own row append, not merely
      // after the asynchronous verifier completes its internal page chain.
      this.metadataComplete = !page.hasMore;
    } catch (error) {
      if (error instanceof Error && error.message === 'projection_scope_staging_capacity_exceeded') throw error;
      throw new ProjectionProtocolIntegrityError(code(error));
    }
  }

  expectFeatureWindows(descriptors: readonly PublicProjectionFeatureWindow[]): void {
    this.assertOpen();
    if (this.nextIndex !== 0 || this.pendingFeatureWindows !== null || descriptors.length === 0) {
      throw new Error('projection_scope_metadata_mode_mismatch');
    }
    for (const window of descriptors) publicProjectionFeatureWindowRequestSchema.parse({ windowContractVersion: '1.0', manifest: this.manifest, window });
    const keys = descriptors.map(value => canonicalPublicProjectionJson(value));
    if (new Set(keys).size !== keys.length || this.manifest.selectedFeatures.some(feature => !descriptors.some(window => window.feature === feature))) {
      throw new Error('projection_scope_feature_window_selection_incomplete');
    }
    this.pendingFeatureWindows = new Set(keys);
  }

  async addFeatureWindow(descriptor: PublicProjectionFeatureWindow, value: PublicProjectionFeatureWindowResult): Promise<void> {
    this.assertOpen();
    const key = canonicalPublicProjectionJson(descriptor);
    if (!this.pendingFeatureWindows?.has(key)) throw new Error('projection_scope_feature_window_unexpected');
    if (value.status === 'reset_required') throw new ProjectionSnapshotResetSignal(value.reason);
    let result: PublicProjectionFeatureWindowResult;
    try { result = await verifyPublicProjectionFeatureWindow({ windowContractVersion: '1.0', manifest: this.manifest, window: descriptor }, value); }
    catch (error) { throw new ProjectionProtocolIntegrityError(code(error)); }
    this.assertOpen();
    if (result.status !== 'ok') throw new Error('projection_scope_feature_window_anchor_unavailable');
    if (!this.pendingFeatureWindows?.has(key)) throw new Error('projection_scope_feature_window_unexpected');
    const additions = result.changes.filter(change => {
      const existing = this.rows.find(row => row.feature === change.feature && row.aggregateId === change.aggregateId);
      if (existing !== undefined && canonicalPublicProjectionJson(existing) !== canonicalPublicProjectionJson(change)) {
        throw new ProjectionProtocolIntegrityError('projection_scope_feature_window_overlap_drift');
      }
      return existing === undefined;
    });
    const bytes = this.measure(additions);
    if (this.bytes + bytes > this.maxBytes) throw new Error('projection_scope_staging_capacity_exceeded');
    this.rows.push(...additions.map(change => freeze(change))); this.bytes += bytes;
    this.featureWindows.push(freeze({ window: result.window, hasEarlier: result.hasEarlier }));
    this.pendingFeatureWindows.delete(key);
    this.metadataComplete = this.pendingFeatureWindows.size === 0;
  }

  async addWindow(descriptor: PublicProjectionMessageWindow,
    value: PublicProjectionMessageWindowResult): Promise<void> {
    this.assertOpen();
    if (this.manifest.scope.kind !== 'session') throw new Error('projection_scope_message_window_owner_invalid');
    if (value.status === 'reset_required') throw new ProjectionSnapshotResetSignal(value.reason);
    let result: PublicProjectionMessageWindowResult;
    try { result = await verifyPublicProjectionMessageWindow({ manifest: this.manifest, window: descriptor }, value); }
    catch (error) { throw new ProjectionProtocolIntegrityError(code(error)); }
    this.assertOpen();
    if (result.status === 'anchor_unavailable') throw new Error('projection_message_window_anchor_unavailable');
    if (result.status !== 'ok') throw new Error('projection_message_window_unavailable');
    if (this.window !== null) throw new Error('projection_scope_staging_window_already_received');
    const bytes = this.measure(result.changes);
    if (this.bytes + bytes > this.maxBytes) throw new Error('projection_scope_staging_capacity_exceeded');
    this.window = freeze(result);
    this.bytes += bytes;
  }

  finish(): ProjectionScopeSnapshot {
    if (this.sealed !== null) return this.sealed;
    if (!this.metadataComplete || (this.manifest.scope.kind === 'session' && this.window === null)) {
      throw new Error('projection_scope_staging_incomplete');
    }
    const changes = [...this.rows, ...(this.window?.changes ?? [])];
    this.sealed = freeze({ manifest: this.manifest, changes, messageWindow: this.window, featureWindows: this.featureWindows, bytes: this.bytes });
    return this.sealed;
  }

  private assertOpen(): void {
    if (this.sealed !== null) throw new Error('projection_scope_staging_already_published');
  }
  private measure(value: unknown): number {
    return new TextEncoder().encode(canonicalPublicProjectionJson(value)).byteLength;
  }
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function code(error: unknown): string {
  return (error instanceof Error ? error.message : 'unknown').replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 512);
}
