import type {
  ConversationAuthorityCommandReceipt,
  ConversationAuthorityEvent,
  ConversationMessageHead,
  ConversationSession,
  MutatedConversationSession
} from '../../conversation/ConversationAuthority.js';
import type {
  ConversationRunHandoffCommit,
  ConversationRunHandoffTransaction
} from './ConversationRunHandoffPersistence.js';

/** Released V1 DTO is frozen independently of the live Public command schema. */
interface ConversationMessageVersion {
  readonly messageId: string;
  readonly version: number;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly role: 'user' | 'assistant';
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly payload: {
    readonly content: string;
    readonly attachments?: readonly import('@ariadne/protocol/public').ImageAttachmentRef[];
    readonly execution?: {
      mode: 'chat' | 'agent' | 'plan';
      modelId?: string | undefined;
      inference?: import('@ariadne/protocol/public').ModelInferenceOptions | undefined;
      routingStrategy?: 'local-first' | 'cloud-first' | 'privacy-first' | 'quality-first' | undefined;
    };
  };
};

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

export interface MutateConversationSessionCommit extends MutatedConversationSession {
  readonly receipt: Extract<
    ConversationAuthorityCommandReceipt,
    { readonly kind: 'conversation.mutate_session' }
  >;
  readonly expectedSessionVersion: number;
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

  loadSessionVersion(
    sessionId: string,
    version: number
  ): Promise<ConversationSession | null>;

  loadMessageHead(messageId: string): Promise<ConversationMessageHead | null>;

  loadMessageVersion(
    messageId: string,
    version: number
  ): Promise<ConversationMessageVersion | null>;

  /** Exact immutable history through the objective, including only ancestors proven by frozen lineage.
   * Inherited messages retain their original Session identity; the final objective belongs to sessionId. */
  loadSessionMessageHistoryThrough(
    sessionId: string,
    messageId: string,
    messageVersion: number
  ): Promise<readonly ConversationMessageVersion[]>;

  loadCommittedAuthorityCommand(
    commandId: string
  ): Promise<CommittedConversationAuthorityCommand | null>;

  commitCreatedSession(commit: CreateConversationSessionCommit): Promise<void>;

  commitMutatedSession(commit: MutateConversationSessionCommit): Promise<void>;

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
