import type { DatabaseSync } from 'node:sqlite';
import type { StoredProjectionCommit } from './StoredProjectionRecords.js';

export interface PublicProjectionPersistenceFaultInjector {
  beforeCommit?(): void;
  afterCommit?(): void;
}
export interface PublicProjectionAppendResult {
  readonly cursor: number;
  readonly streamId: string;
  readonly replayed: boolean;
}
export interface ProjectionLedgerAppendHooks {
  beforeChanges?(): void;
  afterChanges?(cursor: number): void;
  onReplay?(commit: StoredProjectionCommit, cursor: number): void;
}
/** The owner supplies its one final transaction to document preparation. */
export type ProjectionLedgerAppender = (database: DatabaseSync, streamId: string,
  commit: StoredProjectionCommit, faults?: PublicProjectionPersistenceFaultInjector,
  hooks?: ProjectionLedgerAppendHooks) => PublicProjectionAppendResult & { readonly changeDigests?: readonly string[] };
