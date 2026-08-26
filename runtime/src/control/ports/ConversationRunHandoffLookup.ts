import type {
  ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';
import type {
  CommittedConversationAuthorityCommand
} from './ConversationAuthorityPersistence.js';
import type {
  ConversationSession
} from '../../conversation/ConversationAuthority.js';

export interface ConversationRunHandoffLookup {
  readSagaByMessage(
    messageId: string,
    messageVersion: number
  ): Promise<ConversationRunHandoffSaga | null>;

  readSession(sessionId: string): Promise<ConversationSession | null>;

  readCommittedAuthorityCommand(
    commandId: string
  ): Promise<CommittedConversationAuthorityCommand | null>;
}
