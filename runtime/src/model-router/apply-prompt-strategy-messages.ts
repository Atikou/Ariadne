import type { ChatMessage } from "../model/types.js";
import {
  applyPromptStrategyToSystemText,
  type PromptStrategy,
} from "./prompt-strategy-builder.js";

/** 将 PromptStrategy 的 system 补充并入首条 system 消息。 */
export function applyPromptStrategyToMessages(
  messages: readonly ChatMessage[],
  strategy: PromptStrategy,
): ChatMessage[] {
  const addendum = strategy.systemAddendum.trim();
  if (!addendum) return [...messages];

  let applied = false;
  return messages.map((message) => {
    if (applied || message.role !== "system") return message;
    applied = true;
    return {
      ...message,
      content: applyPromptStrategyToSystemText(message.content, strategy),
    };
  });
}
