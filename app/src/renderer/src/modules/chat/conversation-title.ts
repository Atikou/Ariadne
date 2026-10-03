const DEFAULT_CONVERSATION_TITLE = 'Conversation';
const IMAGE_ONLY_CONVERSATION_TITLE = '图片消息';
const MAX_AUTO_TITLE_LENGTH = 32;

/**
 * Turns the first user message into a compact session label. This is deliberately
 * deterministic so the title is available immediately while the optional model
 * title request is running. The model result can replace it through the normal
 * rename command.
 */
export function deriveConversationTitle(
  content: string,
  hasAttachments = false
): string {
  const normalized = content
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) {
    return hasAttachments ? IMAGE_ONLY_CONVERSATION_TITLE : DEFAULT_CONVERSATION_TITLE;
  }

  const withoutPromptFiller = normalized.replace(
    /^(?:请问|请帮我|帮我|麻烦你|能否|可以帮我|请|我想要|我想)\s*/u,
    ''
  ).trim();
  const firstThought = (withoutPromptFiller || normalized)
    .split(/[。！？!?；;]/u, 1)[0]
    ?.trim() ?? normalized;
  const compact = firstThought || normalized;
  return compact.length <= MAX_AUTO_TITLE_LENGTH
    ? compact
    : `${compact.slice(0, MAX_AUTO_TITLE_LENGTH - 1).trimEnd()}…`;
}
