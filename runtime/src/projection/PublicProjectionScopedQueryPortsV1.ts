import type { PublicProjectionScopedReadRequest, PublicProjectionScopedReadBatch } from '@ariadne/protocol/public';

/** Continuous scan watermarks with entity bodies restricted to one subscription. */
export interface PublicProjectionScopedQueryStoreV1 {
  readScope(request: PublicProjectionScopedReadRequest): Promise<PublicProjectionScopedReadBatch>;
}
