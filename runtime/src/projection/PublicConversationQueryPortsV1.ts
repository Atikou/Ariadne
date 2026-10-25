import type { PublicConversationReceiptRequest, PublicConversationReceiptResult,
  PublicConversationInferenceRequest, PublicConversationInferenceResult } from '@ariadne/protocol/public';
/** Draft exact-Session invalidation and prefixes at the same Catalog C as messages. */
export interface PublicConversationQueryStoreV1 {
  readConversationReceipts(request: PublicConversationReceiptRequest): Promise<PublicConversationReceiptResult>;
  readConversationInferenceWindow(request: PublicConversationInferenceRequest): Promise<PublicConversationInferenceResult>;
}
