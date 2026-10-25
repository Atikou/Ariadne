import { useEffect, useRef } from 'react';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { ConversationSessionQueryItem } from '@renderer/core/runtime/features/session-feature-store';
import { PERSONAL_ASSISTANT_WORKSPACE_ID } from '@ariadne/protocol/public';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { openConversationSearchResult, type ConversationSearchResults as SearchResults } from './conversation-search';

export function ConversationSearchResults({ services, results }: {
  services: ModuleServices; results: SearchResults | null;
}): React.JSX.Element {
  const action = usePanelAction(), generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [results]);
  const open = async (item: ConversationSessionQueryItem): Promise<void> => {
    const ticket = ++generation.current;
    await openConversationSearchResult(services, item, () => ticket === generation.current);
    if (ticket !== generation.current) return;
    services.conversationNavigation.setSessionUnread(item.sessionId, false);
    if (item.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID) services.conversationNavigation.selectAssistant();
    else await services.conversationNavigation.selectWorkspace(item.workspaceId);
  };
  return <div className="conversation-search-results" aria-label="会话搜索结果" aria-busy={results === null || action.pending}>
    {results === null ? <p>正在搜索会话…</p> : <>
      {results.items.length === 0 && <p>没有找到匹配的会话。</p>}
      {results.items.map(item => <button type="button" className="conversation-search-result" key={item.sessionId}
        disabled={action.pending} onClick={() => void action.execute(() => open(item))} data-session-id={item.sessionId}>
        <strong>{item.title}</strong>
        {item.matches[0] && <span>{item.matches[0].snippet}</span>}
        <small>{item.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID ? '个人助手' : '工作区会话'}</small>
      </button>)}
      {results.limited && <p>每个工作区最多 50 项，当前最多显示 128 项。请缩小关键词以查找更多结果。</p>}
    </>}
    {action.error && <p role="alert">{action.error}</p>}
  </div>;
}
