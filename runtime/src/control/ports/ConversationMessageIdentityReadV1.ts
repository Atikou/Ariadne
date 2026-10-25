import type { ConversationMessageReference } from '@ariadne/protocol/public';

/** Read extension of the original Conversation owner, without message bodies. */
export interface ConversationMessageIdentityReadV1 {
  readMessageIdentity(messageId: string, version: number): Promise<{
    readonly reference: ConversationMessageReference;
    readonly workspaceId: string;
    readonly role: 'user' | 'assistant';
    readonly executionMode: 'chat' | 'agent' | null;
  } | null>;
}
