import type {
  ConversationAuthorityEvent,
  ConversationMessageVersion,
  ConversationSession
} from '../conversation/ConversationAuthority.js';

export interface ConversationProjectionReadRequest {
  readonly afterCursor: number;
  readonly limit: number;
}

export interface ConversationProjectionRecord {
  readonly cursor: number;
  readonly event: ConversationAuthorityEvent;
  /** Current head is used only to prove identity and recover createdAt. */
  readonly session: ConversationSession;
  readonly messageVersion: ConversationMessageVersion | null;
}

/** Append-only authority-event reader used to rebuild public projections. */
export interface ConversationProjectionReader {
  readProjectionRecords(
    request: ConversationProjectionReadRequest
  ): Promise<readonly ConversationProjectionRecord[]>;
}
