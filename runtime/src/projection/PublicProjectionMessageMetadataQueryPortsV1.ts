import type { PublicMessageMetadataWindowRequest, PublicMessageMetadataWindowResult,
  PublicMessageBodyRequest, PublicMessageBodyResult } from '@ariadne/protocol/public';
/** Draft body-free merged windows at the exact document Catalog C. */
export interface PublicProjectionMessageMetadataQueryStoreV1 {
  readMessageMetadataWindow(request: PublicMessageMetadataWindowRequest): Promise<PublicMessageMetadataWindowResult>;
  readMessageBody(request: PublicMessageBodyRequest): Promise<PublicMessageBodyResult>;
}
