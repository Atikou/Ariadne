import type { ConversationSessionQueryItem, SessionFeatureStore } from '@renderer/core/runtime/features/session-feature-store';
import type { MessageFeatureStore } from '@renderer/core/runtime/features/message-feature-store';

export const SEARCH_RESULT_LIMIT = 128;
export const SEARCH_WORKSPACE_LIMIT = 50;
export interface ConversationSearchResults {
  readonly items: readonly ConversationSessionQueryItem[];
  readonly limited: boolean;
}

/** Query results are their own read model, independent of the visible directory
 * page. At most four physical workspace queries and 128 retained rows. */
export async function searchConversations(sessions: Pick<SessionFeatureStore, 'query'>,
  workspaceIds: readonly string[], query: string, current: () => boolean): Promise<ConversationSearchResults | null> {
  const ids = [...new Set(workspaceIds)].sort(); let items: ConversationSessionQueryItem[] = [], limited = false;
  for (let offset = 0; offset < ids.length; offset += 4) {
    if (!current()) return null;
    const groups = await Promise.all(ids.slice(offset, offset + 4).map(id => sessions.query(id, query, 'active', SEARCH_WORKSPACE_LIMIT)));
    if (!current()) return null;
    limited ||= groups.some(group => group.length === SEARCH_WORKSPACE_LIMIT);
    items = [...items, ...groups.flat()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
    limited ||= items.length > SEARCH_RESULT_LIMIT;
    items = items.slice(0, SEARCH_RESULT_LIMIT);
  }
  return { items, limited };
}

/** Immutable reference lookup precedes loading its nearby public Message range.
 * A deleted reference or newer Session selection never falls back to an
 * unrelated latest page. */
export async function openConversationSearchResult(services: {
  sessions: Pick<SessionFeatureStore, 'select' | 'resolveMessage' | 'view'>;
  messages: Pick<MessageFeatureStore, 'showWindow' | 'view'>;
}, item: ConversationSessionQueryItem, current: () => boolean): Promise<void> {
  const reference = item.matches[0]?.reference;
  if (reference !== undefined) await services.sessions.resolveMessage(reference);
  if (!current()) return;
  await services.sessions.select(item.sessionId);
  if (!current() || services.sessions.view.getSnapshot().selectedSessionId !== item.sessionId) return;
  if (reference !== undefined) {
    await services.messages.showWindow({ kind: 'around', anchorMessageId: reference.messageId, limit: 64 });
    if (!current() || services.sessions.view.getSnapshot().selectedSessionId !== item.sessionId) return;
    const visible = services.messages.view.getSnapshot().messages.find(message => message.messageId === reference.messageId)?.reference;
    if (visible?.sessionId !== reference.sessionId || visible.messageVersion !== reference.messageVersion
      || visible.contentDigest !== reference.contentDigest) throw new Error('消息已更新，请重新搜索以定位当前版本。');
  }
}
