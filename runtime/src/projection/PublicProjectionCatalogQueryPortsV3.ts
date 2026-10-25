import type { PublicProjectionCatalogBeginRequest, PublicProjectionCatalogManifest, PublicProjectionCatalogReset,
  PublicProjectionCatalogPageRequest, PublicProjectionCatalogPageResult,
  PublicProjectionCatalogDetailRequest, PublicProjectionCatalogDetailResult,
  PublicProjectionCatalogReadRequest, PublicProjectionCatalogBatchResult } from '@ariadne/protocol/public';

/** Minimal catalogs and explicit entity details share the existing Projection's immutable boundary. */
export interface PublicProjectionCatalogQueryStoreV3 {
  beginCatalogSnapshot(request: PublicProjectionCatalogBeginRequest): Promise<PublicProjectionCatalogManifest | PublicProjectionCatalogReset>;
  readCatalogPage(request: PublicProjectionCatalogPageRequest): Promise<PublicProjectionCatalogPageResult>;
  readCatalogDetail(request: PublicProjectionCatalogDetailRequest): Promise<PublicProjectionCatalogDetailResult>;
  readCatalogCommits(request: PublicProjectionCatalogReadRequest): Promise<PublicProjectionCatalogBatchResult>;
}
