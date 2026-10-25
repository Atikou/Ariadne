import { comparePublicProjectionMessages } from '@ariadne/protocol/public';

interface ConversationMessageOrderKey {
  readonly messageId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly createdAt: string;
}

export function compareConversationMessages(
  left: ConversationMessageOrderKey,
  right: ConversationMessageOrderKey
): number {
  return comparePublicProjectionMessages(left, right);
}
