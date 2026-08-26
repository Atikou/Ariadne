import type {
  ConversationRunHandoffOutboxMessage,
  ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';

export interface ConversationOutboxClaimRequest {
  readonly claimId: string;
  readonly limit: number;
  readonly leaseMs: number;
}

export interface ClaimedConversationOutboxMessage {
  readonly cursor: number;
  readonly claimId: string;
  readonly claimedAt: string;
  readonly claimExpiresAt: string;
  readonly claimAttempts: number;
  readonly message: ConversationRunHandoffOutboxMessage;
}

export interface ConversationOutboxAcknowledgement {
  readonly cursor: number;
  readonly messageId: string;
}

export interface ConversationOutboxPublishRequest {
  readonly claimId: string;
  readonly messages: readonly ConversationOutboxAcknowledgement[];
}

/**
 * Durable Conversation-side boundary consumed by cross-store coordinators.
 * Reading the saga supplies immutable identity that intentionally is not
 * duplicated onto every public outbox message.
 */
export interface ConversationRunHandoffOutboxPort {
  claimPending(
    request: ConversationOutboxClaimRequest
  ): Promise<readonly ClaimedConversationOutboxMessage[]>;

  acknowledgePublished(request: ConversationOutboxPublishRequest): Promise<void>;

  /** Exact count of durable rows that have not reached their ACK boundary. */
  countPendingHandoffOutbox(): Promise<number>;

  readSaga(sagaId: string): Promise<ConversationRunHandoffSaga | null>;
}
