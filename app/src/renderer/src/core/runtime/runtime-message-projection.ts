import { compareConversationMessages } from './conversation-message-order';
import type { RuntimeMessage } from './runtime-projection-presenter';

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
