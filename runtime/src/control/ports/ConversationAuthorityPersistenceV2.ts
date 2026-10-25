import type { ConversationMessageVersion } from '../../conversation/ConversationAuthority.js';
import type {
  AcceptConversationUserMessageCommit as AcceptV1,
  ProjectConversationAgentResultCommit as ResultV1,
  ProjectConversationAgentStartFailureCommit as FailureV1,
  ConversationAuthorityTransaction as TransactionV1
} from './ConversationAuthorityPersistence.js';

export type {
  CommittedConversationAuthorityCommand,
  CreateConversationSessionCommit,
  MutateConversationSessionCommit
} from './ConversationAuthorityPersistence.js';

/** Same Conversation owner and physical schema. V2 admits explicit model and
 * local fallback metadata; the released V1 signature remains frozen. Historical
 * payloads retain their original bytes/digests and are validated at read time. */
export interface AcceptConversationUserMessageCommit extends Omit<AcceptV1, 'messageVersion'> {
  readonly messageVersion: ConversationMessageVersion;
}
export interface ProjectConversationAgentResultCommit extends Omit<ResultV1, 'messageVersion'> {
  readonly messageVersion: ConversationMessageVersion;
}
export interface ProjectConversationAgentStartFailureCommit extends Omit<FailureV1, 'messageVersion'> {
  readonly messageVersion: ConversationMessageVersion;
}

export interface ConversationAuthorityTransaction extends Omit<TransactionV1,
  'loadMessageVersion' | 'loadSessionMessageHistoryThrough' | 'commitAcceptedUserMessage'
  | 'commitProjectedAgentResult' | 'commitProjectedAgentStartFailure'> {
  loadMessageVersion(messageId: string, version: number): Promise<ConversationMessageVersion | null>;
  loadSessionMessageHistoryThrough(sessionId: string, messageId: string, messageVersion: number): Promise<readonly ConversationMessageVersion[]>;
  commitAcceptedUserMessage(commit: AcceptConversationUserMessageCommit): Promise<void>;
  commitProjectedAgentResult(commit: ProjectConversationAgentResultCommit): Promise<void>;
  commitProjectedAgentStartFailure(commit: ProjectConversationAgentStartFailureCommit): Promise<void>;
}

export interface ConversationAuthorityUnitOfWorkV2 {
  authorityTransaction<T>(operation: (transaction: ConversationAuthorityTransaction) => Promise<T>): Promise<T>;
}
export type ConversationAuthorityUnitOfWork = ConversationAuthorityUnitOfWorkV2;
