import type {
  PublicProjectionSnapshotBeginRequest,
  PublicProjectionSnapshotManifest,
  PublicProjectionSnapshotPageRequest,
  PublicProjectionSnapshotPageResult
} from '@ariadne/protocol/public';

/** Versioned replacement read boundary; current scalar snapshot ABI stays frozen. */
export interface PublicProjectionPagedQueryStoreV1 {
  beginSnapshot(request: PublicProjectionSnapshotBeginRequest): Promise<PublicProjectionSnapshotManifest
    | Extract<PublicProjectionSnapshotPageResult, { status: 'reset_required' }>>;
  readSnapshotPage(request: PublicProjectionSnapshotPageRequest): Promise<PublicProjectionSnapshotPageResult>;
}
