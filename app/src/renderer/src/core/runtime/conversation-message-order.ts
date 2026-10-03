interface ConversationMessageOrderKey {
  readonly messageId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly createdAt: string;
}

export function compareConversationMessages(
  left: ConversationMessageOrderKey,
  right: ConversationMessageOrderKey
): number {
  const time = left.createdAt.localeCompare(right.createdAt);
  if (time !== 0) return time;
  const role = conversationRoleOrder(left.role) - conversationRoleOrder(right.role);
  return role !== 0 ? role : left.messageId.localeCompare(right.messageId);
}

function conversationRoleOrder(role: ConversationMessageOrderKey['role']): number {
  if (role === 'user') return 0;
  if (role === 'assistant') return 1;
  return 2;
}
