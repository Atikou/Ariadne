import type { PublicRunProjectionV3 } from '@ariadne/protocol/public';
import { compareConversationMessages } from './conversation-message-order';
import { presentMessage, type RuntimeMessage } from './runtime-projection-presenter';

/** Joins authority-owned interaction messages without inventing message identities. */
export function mergeInteractionMessages(
  authoritative: readonly RuntimeMessage[],
  runs: readonly PublicRunProjectionV3[]
): RuntimeMessage[] {
  const messages = [...authoritative];
  const identities = new Set(messages.map(message => message.messageId));
  for (const run of runs) {
    for (const interaction of run.interactionMessages) {
      if (identities.has(interaction.messageId)) continue;
      identities.add(interaction.messageId);
      messages.push(presentMessage(interaction));
    }
  }
  return messages.sort(compareConversationMessages);
}

/** The durable history is already sorted. Insert only the small live suffix. */
export function mergeLiveMessages(history: readonly RuntimeMessage[], live: readonly RuntimeMessage[]): RuntimeMessage[] {
  const messages = [...history];
  for (const message of live) {
    let low = 0;
    let high = messages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareConversationMessages(messages[middle]!, message) <= 0) low = middle + 1;
      else high = middle;
    }
    messages.splice(low, 0, message);
  }
  return messages;
}
