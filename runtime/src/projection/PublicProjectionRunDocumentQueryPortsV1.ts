import type { PublicRunDocumentRootRequest, PublicRunDocumentRootResult, PublicRunDocumentMetadataRequest,
  PublicRunDocumentMetadataResult, PublicRunDocumentInboxRequest, PublicRunDocumentInboxResult,
  PublicRunDocumentChunkRequest, PublicRunDocumentChunkResult } from '@ariadne/protocol/public';

/** Explicit body queries at the same leased Catalog boundary; metadata is not
 * a complete Run DTO and never implies that unqueried items are absent. */
export interface PublicProjectionRunDocumentQueryStoreV1 {
  readRunDocument(request: PublicRunDocumentRootRequest): Promise<PublicRunDocumentRootResult>;
  readRunDocumentMetadataPage(request: PublicRunDocumentMetadataRequest): Promise<PublicRunDocumentMetadataResult>;
  readRunDocumentInboxInput(request: PublicRunDocumentInboxRequest): Promise<PublicRunDocumentInboxResult>;
  readRunDocumentChunk(request: PublicRunDocumentChunkRequest): Promise<PublicRunDocumentChunkResult>;
}
