import type { PublicModelProjectionV3 } from '@ariadne/protocol/public';

import type { PublicProjectionCommitSink } from './PublicProjectionPorts.js';

/** Public, secret-free model state owned by the Runtime model domain. */
export interface ModelCatalogProjectionEntry {
  readonly id: string;
  readonly label: string;
  readonly location: 'local' | 'remote';
  readonly availability: 'ready' | 'unavailable' | 'checking' | 'error';
  readonly supportsAgent: boolean;
  readonly supportsVision: boolean;
}

/**
 * Current-state source used by the rebuildable public projector. Implementors
 * must return one immutable, internally consistent catalog snapshot.
 */
export interface ModelCatalogProjectionSource {
  snapshot():
    | readonly ModelCatalogProjectionEntry[]
    | Promise<readonly ModelCatalogProjectionEntry[]>;
}

/** Narrow durable head required to reconcile update/delete versions. */
export interface ModelCatalogProjectionHead {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly operation: 'upsert' | 'delete';
  readonly dto: PublicModelProjectionV3 | null;
}

/**
 * Internal projection-store surface for the Model catalog publisher. It does
 * not expose SQLite or turn the public read model into a business authority.
 */
export interface ModelCatalogPublicProjectionStore
extends PublicProjectionCommitSink {
  readModelProjectionHeads(): Promise<readonly ModelCatalogProjectionHead[]>;
  readPublicProjectionSourceCheckpoint(sourceId: string): Promise<number>;
}
