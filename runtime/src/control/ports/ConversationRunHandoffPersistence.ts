import type {
  ConversationRunHandoffEvent,
  ConversationRunHandoffOutboxMessage,
  ConversationRunHandoffSaga
} from '../../conversation/ConversationRunHandoffSaga.js';

export interface CommittedConversationRunHandoffCommand {
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly sagaId: string;
  readonly resultingVersion: number;
  readonly saga: ConversationRunHandoffSaga;
  readonly event: ConversationRunHandoffEvent;
  readonly outbox: ConversationRunHandoffOutboxMessage;
}

export interface ConversationRunHandoffCommit
extends CommittedConversationRunHandoffCommand {
  readonly expectedVersion: number | null;
}

export interface ConversationRunHandoffTransaction {
  loadSaga(sagaId: string): Promise<ConversationRunHandoffSaga | null>;
  loadCommittedCommand(
    commandId: string
  ): Promise<CommittedConversationRunHandoffCommand | null>;
  commit(commit: ConversationRunHandoffCommit): Promise<void>;
}

export interface ConversationRunHandoffUnitOfWork {
  transaction<T>(
    operation: (transaction: ConversationRunHandoffTransaction) => Promise<T>
  ): Promise<T>;
}
