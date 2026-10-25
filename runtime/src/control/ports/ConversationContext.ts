import type { ConversationMessageReference } from '@ariadne/protocol/public';

export interface FrozenConversationContext {
  readonly sourceSessionId: string;
  readonly sourceSessionVersion: number;
  readonly boundary?: ConversationMessageReference;
}
