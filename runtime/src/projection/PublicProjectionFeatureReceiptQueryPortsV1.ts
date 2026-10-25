import type { PublicProjectionFeatureReceiptRequest, PublicProjectionFeatureReceiptResult } from '@ariadne/protocol/public';

/** Draft independent invalidation query; frozen complete scoped read V1 is unchanged. */
export interface PublicProjectionFeatureReceiptQueryStoreV1 {
  readFeatureReceipts(request: PublicProjectionFeatureReceiptRequest): Promise<PublicProjectionFeatureReceiptResult>;
}
