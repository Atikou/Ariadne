import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, Folder, FolderOpen, MessageSquarePlus, Pin, Search, Trash2 } from 'lucide-react';
import type { ConversationSession, RunSummary } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';

interface ConversationSidebarProps {
  services: ModuleServices;
}

interface WorkspaceGroup {
  workspace: ConversationWorkspace;
  sessions: ConversationSession[];
}

interface HoveredConversation {
  sessionId: string;
  workspaceId: string;
  top: number;
  left: number;
}

const FALLBACK_WORKSPACE: ConversationWorkspace = {
  workspaceId: 'primary',
  name: '当前工作区',
  rootPath: ''
};

export function ConversationSidebar({ services }: ConversationSidebarProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const [query, setQuery] = useState('');
  const [workspaces, setWorkspaces] = useState<readonly ConversationWorkspace[]>([FALLBACK_WORKSPACE]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(FALLBACK_WORKSPACE.workspaceId);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ConversationSession | null>(null);
  const [hovered, setHovered] = useState<HoveredConversation | null>(null);
  const [pinRevision, setPinRevision] = useState(0);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelRenameRef = useRef(false);

  useEffect(() => {
    let active = true;
    void services.conversationNavigation.listWorkspaces().then((catalog) => {
      if (!active || catalog.length === 0) return;
      setWorkspaces(catalog);
      setSelectedWorkspaceId(services.conversationNavigation.getSelectedWorkspaceId() ?? catalog[0]!.workspaceId);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [services]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => groupSessionsByWorkspace(
    workspaces,
    runtime.sessions,
    normalizedQuery,
    (session) => services.conversationNavigation.isSessionPinned(session.sessionId, session.pinned)
  ), [normalizedQuery, pinRevision, runtime.sessions, selectedWorkspaceId, services, workspaces]);

  const hoveredSession = hovered
    ? runtime.sessions.find((session) => session.sessionId === hovered.sessionId) ?? null
    : null;
  const hoveredWorkspace = hovered
    ? workspaces.find((workspace) => workspace.workspaceId === hovered.workspaceId) ?? null
    : null;
  const hoveredRun = hoveredSession ? latestSessionRun(runtime.runs, hoveredSession.sessionId) : null;

  const toggleWorkspace = (workspaceId: string): void => {
    setSelectedWorkspaceId(workspaceId);
    void services.conversationNavigation.selectWorkspace(workspaceId).catch(() => undefined);
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const selectSession = (session: ConversationSession, workspaceId: string): void => {
    setSelectedWorkspaceId(workspaceId);
    void services.conversationNavigation.selectWorkspace(workspaceId).catch(() => undefined);
    void services.runtime.selectSession(session.sessionId).catch(() => undefined);
  };

  const createSession = async (): Promise<void> => {
    const displayedSession = runtime.sessions.find((session) => session.sessionId === runtime.selectedSessionId);
    const workspaceId = displayedSession?.workspaceId
      ?? (workspaces.some((workspace) => workspace.workspaceId === selectedWorkspaceId)
        ? selectedWorkspaceId
        : workspaces[0]?.workspaceId);
    if (!workspaceId) return;
    setActionError(null);
    try {
      await services.runtime.createSession({ workspaceId });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const openWorkspace = async (): Promise<void> => {
    if (openingWorkspace) return;
    setOpeningWorkspace(true);
    setActionError(null);
    try {
      const opened = await services.conversationNavigation.openWorkspace();
      if (!opened) return;
      const catalog = await services.conversationNavigation.listWorkspaces();
      setWorkspaces(catalog);
      setSelectedWorkspaceId(opened.workspaceId);
      setCollapsedWorkspaceIds((current) => {
        const next = new Set(current);
        next.delete(opened.workspaceId);
        return next;
      });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const beginRename = (session: ConversationSession): void => {
    cancelRenameRef.current = false;
    setHovered(null);
    setEditingSessionId(session.sessionId);
    setRenameDraft(session.title);
  };

  const commitRename = (session: ConversationSession): void => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditingSessionId(null);
      return;
    }
    const nextTitle = renameDraft.trim();
    setEditingSessionId(null);
    if (!nextTitle || nextTitle === session.title) return;
    void services.runtime.renameSession(session.sessionId, nextTitle).catch(() => undefined);
  };

  const showDetails = (event: MouseEvent<HTMLDivElement>, session: ConversationSession, workspace: ConversationWorkspace): void => {
    if (editingSessionId === session.sessionId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const cardWidth = 276;
    const cardHeight = 150;
    const left = bounds.right + 9 + cardWidth <= window.innerWidth
      ? bounds.right + 9
      : Math.max(8, bounds.left - cardWidth - 9);
    const top = Math.min(Math.max(8, bounds.top - 6), window.innerHeight - cardHeight - 8);
    setHovered({ sessionId: session.sessionId, workspaceId: workspace.workspaceId, top, left });
  };

  return (
    <aside className="chat-conversations-sidebar" aria-label="会话列表">
      <div className="conversations-actions">
        <div className="conversations-heading">
          <strong>会话</strong>
        </div>
        <div className="conversation-primary-actions">
          <button
            type="button"
            className="conversation-primary-action conversation-open-workspace-button"
            disabled={openingWorkspace}
            onClick={() => void openWorkspace()}
          ><FolderOpen size={14} /><span>{openingWorkspace ? '正在打开…' : '打开工作区'}</span></button>
          <button
            type="button"
            className="conversation-primary-action conversation-create-button"
            aria-label="新建会话"
            disabled={runtime.status.availability !== 'ready'}
            onClick={() => void createSession()}
          ><MessageSquarePlus size={14} /><span>新建会话</span></button>
        </div>
        {actionError && <p className="conversation-action-error" role="alert">{actionError}</p>}
        <label className="conversation-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
        </label>
      </div>

      <div className="conversation-groups">
        {groups.map(({ workspace, sessions }) => {
          const collapsed = collapsedWorkspaceIds.has(workspace.workspaceId);
          return <section className={`conversation-workspace${collapsed ? ' is-collapsed' : ''}`} key={workspace.workspaceId}>
            <button
              type="button"
              className={`conversation-workspace-header${selectedWorkspaceId === workspace.workspaceId ? ' is-selected' : ''}`}
              data-workspace-id={workspace.workspaceId}
              aria-pressed={selectedWorkspaceId === workspace.workspaceId}
              aria-expanded={!collapsed}
              onClick={() => toggleWorkspace(workspace.workspaceId)}
            >
              <Folder size={14} />
              <span>{workspace.name}</span>
              <small>{sessions.length}</small>
            </button>
            {!collapsed && <div className="workspace-conversation-list">
              {sessions.map((session) => {
                const pinned = services.conversationNavigation.isSessionPinned(session.sessionId, session.pinned);
                const editing = editingSessionId === session.sessionId;
                return (
                  <div
                    className={`conversation-row${runtime.selectedSessionId === session.sessionId ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}`}
                    data-session-id={session.sessionId}
                    key={session.sessionId}
                    onMouseEnter={(event) => showDetails(event, session, workspace)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <div
                      className="conversation-row-main"
                      role="button"
                      tabIndex={0}
                      aria-current={runtime.selectedSessionId === session.sessionId ? 'page' : undefined}
                      onClick={() => {
                        if (!editing) selectSession(session, workspace.workspaceId);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        beginRename(session);
                      }}
                      onKeyDown={(event) => selectSessionFromKeyboard(event, editing, () => {
                        selectSession(session, workspace.workspaceId);
                      })}
                    >
                      {editing ? (
                        <input
                          className="conversation-title-input"
                          aria-label={`编辑会话名称：${session.title}`}
                          autoFocus
                          value={renameDraft}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={() => commitRename(session)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelRenameRef.current = true;
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      ) : (
                        <span className="conversation-title">
                          <span>{session.title}</span>
                          {pinned && <Pin className="conversation-pinned-marker" size={11} aria-label="已置顶" />}
                        </span>
                      )}
                    </div>
                    {!editing && <div className="conversation-row-actions" aria-label="会话操作">
                      <button
                        type="button"
                        className={pinned ? 'is-pinned' : undefined}
                        aria-label={pinned ? `取消置顶：${session.title}` : `置顶会话：${session.title}`}
                        aria-pressed={pinned}
                        onClick={() => {
                          services.conversationNavigation.setSessionPinned(session.sessionId, !pinned);
                          setPinRevision((revision) => revision + 1);
                        }}
                      ><Pin size={12} /></button>
                      <button type="button" aria-label={`删除会话：${session.title}`} onClick={() => setDeleteTarget(session)}><Trash2 size={12} /></button>
                    </div>}
                  </div>
                );
              })}
              {runtime.initialized && sessions.length === 0 && <p className="workspace-empty-state">暂无会话</p>}
            </div>}
          </section>;
        })}
      </div>

      {hovered && hoveredSession && hoveredWorkspace && createPortal(
        <ConversationDetailsPopover
          session={hoveredSession}
          workspace={hoveredWorkspace}
          run={hoveredRun}
          pinned={services.conversationNavigation.isSessionPinned(hoveredSession.sessionId, hoveredSession.pinned)}
          top={hovered.top}
          left={hovered.left}
        />,
        document.body
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个会话？"
        description={deleteTarget ? `“${deleteTarget.title}”及其中保存的消息将被删除。` : ''}
        confirmLabel="删除"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void services.runtime.deleteSession(target.sessionId).catch(() => undefined);
        }}
      />
    </aside>
  );
}

function ConversationDetailsPopover({ session, workspace, run, pinned, top, left }: {
  session: ConversationSession;
  workspace: ConversationWorkspace;
  run: RunSummary | null;
  pinned: boolean;
  top: number;
  left: number;
}): React.JSX.Element {
  return <aside className="conversation-details-popover" role="tooltip" style={{ top, left }}>
    <header><strong>{session.title}</strong><span>{formatRelativeTime(session.updatedAt)}</span></header>
    <div><Folder size={13} /><span>{workspace.name}</span></div>
    <div><Clock3 size={13} /><span>更新于 {formatFullTime(session.updatedAt)}</span></div>
    <div><Pin size={13} /><span>{pinned ? '已置顶' : '普通会话'}</span></div>
    {run && <footer><span className={`conversation-run-dot is-${run.status}`} />{run.userFacingLabel} · {formatRunStatus(run.status)}</footer>}
  </aside>;
}

function groupSessionsByWorkspace(
  workspaces: readonly ConversationWorkspace[],
  sessions: readonly ConversationSession[],
  query: string,
  isPinned: (session: ConversationSession) => boolean
): WorkspaceGroup[] {
  return workspaces.map((workspace) => {
    const candidates = sessions.filter((session) => session.workspaceId === workspace.workspaceId);
    const workspaceMatches = workspace.name.toLocaleLowerCase().includes(query);
    return {
      workspace,
      sessions: candidates
        .filter((session) => !query || workspaceMatches || session.title.toLocaleLowerCase().includes(query))
        .sort((left, right) => {
          const pinDifference = Number(isPinned(right)) - Number(isPinned(left));
          return pinDifference || right.updatedAt.localeCompare(left.updatedAt);
        })
    };
  });
}

function selectSessionFromKeyboard(event: KeyboardEvent<HTMLDivElement>, editing: boolean, select: () => void): void {
  if (editing || event.target instanceof HTMLInputElement) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  select();
}

function latestSessionRun(runs: readonly RunSummary[], sessionId: string): RunSummary | null {
  return runs
    .filter((run) => run.sessionId === sessionId)
    .sort((left, right) => (right.startedAt ?? right.completedAt ?? '').localeCompare(left.startedAt ?? left.completedAt ?? ''))[0]
    ?? null;
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (elapsedSeconds < 60) return '刚刚';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function formatFullTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
