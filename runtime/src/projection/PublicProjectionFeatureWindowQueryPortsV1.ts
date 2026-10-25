import type { PublicProjectionFeatureWindowRequest, PublicProjectionFeatureWindowResult } from '@ariadne/protocol/public';

/** Bounded diagnostics/models and exact-Session inference stream windows at an existing V2 boundary. */
export interface PublicProjectionFeatureWindowQueryStoreV1 {
  readFeatureWindow(request: PublicProjectionFeatureWindowRequest): Promise<PublicProjectionFeatureWindowResult>;
}
