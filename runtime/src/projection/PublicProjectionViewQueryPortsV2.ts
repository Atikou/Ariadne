import type {
  PublicProjectionViewBeginRequest, PublicProjectionViewManifest, PublicProjectionViewPageRequest,
  PublicProjectionViewPageResult, PublicProjectionMessageWindowRequest, PublicProjectionMessageWindowResult
} from '@ariadne/protocol/public';

/** Selected metadata and bounded Message windows share one immutable boundary. */
export interface PublicProjectionViewQueryStoreV2 {
  beginViewSnapshot(request: PublicProjectionViewBeginRequest): Promise<PublicProjectionViewManifest
    | Extract<PublicProjectionViewPageResult, { status: 'reset_required' }>>;
  readViewSnapshotPage(request: PublicProjectionViewPageRequest): Promise<PublicProjectionViewPageResult>;
  readMessageWindow(request: PublicProjectionMessageWindowRequest): Promise<PublicProjectionMessageWindowResult>;
}
