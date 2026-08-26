import type {
  ConversationAuthorityCommandReceipt,
  ConversationAuthorityEvent,
  ConversationMessageHead,
  ConversationMessageVersion,
  ConversationSession
} from '../../conversation/ConversationAuthority.js';
import type {
  ConversationRunHandoffCommit,
  ConversationRunHandoffTransaction
} from './ConversationRunHandoffPersistence.js';

export interface CommittedConversationAuthorityCommand {
  readonly receipt: ConversationAuthorityCommandReceipt;
  readonly event: ConversationAuthorityEvent;
}

export interface CreateConversationSessionCommit {
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.create_session' }
  >;
  readonly session: ConversationSession;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.session.created' }
  >;
}

export interface AcceptConversationUserMessageCommit {
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.accept_user_message' }
  >;
  readonly expectedSessionVersion: number;
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.user_message.accepted' }
  >;
  readonly handoff: ConversationRunHandoffCommit;
}

export interface ProjectConversationAgentResultCommit {
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.project_agent_result' }
  >;
  readonly expectedSessionVersion: number;
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<
    ConversationAuthorityEvent,
    { readonly type: 'conversation.agent_result.projected' }
  >;
  readonly handoff: ConversationRunHandoffCommit;
}

export interface ProjectConversationAgentStartFailureCommit {
  readonly receipt: Extract<ConversationAuthorityCommandReceipt, {
    readonly kind: 'conversation.project_agent_start_failure';
  }>;
  readonly expectedSessionVersion: number;
  readonly session: ConversationSession;
  readonly messageHead: ConversationMessageHead;
  readonly messageVersion: ConversationMessageVersion;
  readonly event: Extract<ConversationAuthorityEvent, {
    readonly type: 'conversation.agent_start.failed';
  }>;
  readonly handoff: ConversationRunHandoffCommit;
}

export interface ConversationAuthorityTransaction
extends ConversationRunHandoffTransaction {
  loadSession(sessionId: string): Promise<ConversationSession | null>;

  loadMessageHead(messageId: string): Promise<ConversationMessageHead | null>;

  loadMessageVersion(
    messageId: string,
    version: number
  ): Promise<ConversationMessageVersion | null>;

  /** Exact immutable message history through one authoritative objective. */
  loadSessionMessageHistoryThrough(
    sessionId: string,
    messageId: string,
    messageVersion: number
  ): Promise<readonly ConversationMessageVersion[]>;

  loadCommittedAuthorityCommand(
    commandId: string
  ): Promise<CommittedConversationAuthorityCommand | null>;

  commitCreatedSession(commit: CreateConversationSessionCommit): Promise<void>;

  commitAcceptedUserMessage(commit: AcceptConversationUserMessageCommit): Promise<void>;

  commitProjectedAgentResult(commit: ProjectConversationAgentResultCommit): Promise<void>;

  commitProjectedAgentStartFailure(
    commit: ProjectConversationAgentStartFailureCommit
  ): Promise<void>;
}

export interface ConversationAuthorityUnitOfWork {
  authorityTransaction<T>(
    operation: (transaction: ConversationAuthorityTransaction) => Promise<T>
  ): Promise<T>;
}
