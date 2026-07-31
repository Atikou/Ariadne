import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Clock3, Folder, FolderOpen, MessageSquarePlus, Pin, Search, Trash2 } from 'lucide-react';
import type { ConversationSession, RunSummary } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';
import { pendingApprovalSessionIds } from '@shared/conversation-approval-state';

interface ConversationSidebarProps {
  services: ModuleServices;
}

interface HoveredConversation {
  sessionId: string;
  top: number;
  left: number;
}

interface SessionRowOptions {
  collapsedByWorkspace?: boolean;
  workspaceChild?: boolean;
}

export function ConversationSidebar({ services }: ConversationSidebarProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const [query, setQuery] = useState('');
  const [workspaces, setWorkspaces] = useState<readonly ConversationWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ConversationSession | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ConversationWorkspace | null>(null);
  const [hovered, setHovered] = useState<HoveredConversation | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pinRevision, setPinRevision] = useState(0);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelRenameRef = useRef(false);

  useEffect(() => {
    let active = true;
    const applyCatalog = (catalog: readonly ConversationWorkspace[]): void => {
      if (!active) return;
      setWorkspaces(catalog);
      setSelectedWorkspaceId((current) => current && catalog.some(
        (workspace) => workspace.workspaceId === current
      ) ? current : null);
      void services.runtime.refresh().catch(() => undefined);
    };
    const unsubscribe = services.conversationNavigation.onWorkspacesChanged(applyCatalog);
    void services.conversationNavigation.listWorkspaces().then(applyCatalog).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [services]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(
    () => runtime.sessions
      .filter((session) => services.conversationNavigation.isWorkspaceActive(session.workspaceId))
      .filter((session) => !normalizedQuery || session.title.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const pinDifference = Number(
          services.conversationNavigation.isSessionPinned(right.sessionId, right.pinned)
        ) - Number(
          services.conversationNavigation.isSessionPinned(left.sessionId, left.pinned)
        );
        return pinDifference || right.updatedAt.localeCompare(left.updatedAt);
      }),
    [normalizedQuery, pinRevision, runtime.sessions, services, workspaces]
  );
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !normalizedQuery
      || workspace.name.toLocaleLowerCase().includes(normalizedQuery)
      || workspace.rootPath.toLocaleLowerCase().includes(normalizedQuery)
      || visibleSessions.some((session) => session.workspaceId === workspace.workspaceId)),
    [normalizedQuery, visibleSessions, workspaces]
  );
  const assistantSessions = useMemo(
    () => visibleSessions.filter(
      (session) => services.conversationNavigation.isAssistantWorkspace(session.workspaceId)
    ),
    [visibleSessions, services]
  );
  const pendingSessionIds = useMemo(
    () => pendingApprovalSessionIds(runtime),
    [runtime.permissions, runtime.planHandoffs, runtime.proposals, runtime.runs]
  );

  const hoveredSession = hovered
    ? runtime.sessions.find((session) => session.sessionId === hovered.sessionId) ?? null
    : null;
  const hoveredWorkspace = hoveredSession
    ? workspaces.find((workspace) => workspace.workspaceId === hoveredSession.workspaceId) ?? null
    : null;
  const hoveredRun = hoveredSession ? latestSessionRun(runtime.runs, hoveredSession.sessionId) : null;

  const selectWorkspace = async (workspaceId: string): Promise<boolean> => {
    setActionError(null);
    try {
      await services.conversationNavigation.selectWorkspace(workspaceId);
      setSelectedWorkspaceId(workspaceId);
      services.runtime.clearSessionSelection();
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    }
  };

  const toggleWorkspace = async (workspaceId: string): Promise<void> => {
    if (!await selectWorkspace(workspaceId)) return;
    setHovered(null);
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const selectSession = (session: ConversationSession): void => {
    setSelectedWorkspaceId(null);
    void services.conversationNavigation.selectWorkspace(session.workspaceId).catch(() => undefined);
    void services.runtime.selectSession(session.sessionId).catch(() => undefined);
  };

  const createSession = async (): Promise<void> => {
    setActionError(null);
    try {
      await services.runtime.createSession({
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {})
      });
      setSelectedWorkspaceId(null);
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
      setSelectedWorkspaceId(opened.workspaceId);
      services.runtime.clearSessionSelection();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const archiveWorkspace = async (workspace: ConversationWorkspace): Promise<void> => {
    setArchiveTarget(null);
    setActionError(null);
    try {
      await services.conversationNavigation.archiveWorkspace(workspace.workspaceId);
      if (selectedWorkspaceId === workspace.workspaceId) {
        setSelectedWorkspaceId(null);
        services.runtime.clearSessionSelection();
      }
    } catch (error) {
      setActionError(errorMessage(error));
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

  const showDetails = (event: MouseEvent<HTMLDivElement>, session: ConversationSession): void => {
    if (editingSessionId === session.sessionId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const cardWidth = 276;
    const cardHeight = 150;
    const left = bounds.right + 9 + cardWidth <= window.innerWidth
      ? bounds.right + 9
      : Math.max(8, bounds.left - cardWidth - 9);
    const top = Math.min(Math.max(8, bounds.top - 6), window.innerHeight - cardHeight - 8);
    setHovered({ sessionId: session.sessionId, top, left });
  };

  const renderSessionRow = (
    session: ConversationSession,
    options: SessionRowOptions = {}
  ): React.JSX.Element => {
    const { collapsedByWorkspace = false, workspaceChild = false } = options;
    const pinned = services.conversationNavigation.isSessionPinned(session.sessionId, session.pinned);
    const waitingForApproval = pendingSessionIds.has(session.sessionId);
    const editing = editingSessionId === session.sessionId;
    return (
      <div
        className={`conversation-row${runtime.selectedSessionId === session.sessionId ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}${waitingForApproval ? ' has-pending-approval' : ''}${workspaceChild ? ' is-workspace-child' : ''}${collapsedByWorkspace ? ' is-workspace-collapsed' : ''}`}
        data-session-id={session.sessionId}
        key={session.sessionId}
        aria-hidden={collapsedByWorkspace || undefined}
        inert={collapsedByWorkspace || undefined}
        style={collapsedByWorkspace ? {
          height: 0,
          borderWidth: 0,
          opacity: 0,
          transform: 'translateY(-5px) scaleY(.92)'
        } : undefined}
        onMouseEnter={(event) => showDetails(event, session)}
        onMouseLeave={() => setHovered(null)}
      >
        <div
          className="conversation-row-main"
          role="button"
          tabIndex={collapsedByWorkspace ? -1 : 0}
          aria-current={runtime.selectedSessionId === session.sessionId ? 'page' : undefined}
          onClick={() => {
            if (!editing) selectSession(session);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            beginRename(session);
          }}
          onKeyDown={(event) => selectSessionFromKeyboard(event, editing, () => selectSession(session))}
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
              <span className="conversation-title-text">{session.title}</span>
              {waitingForApproval && <>
                <span className="conversation-approval-badge">等待批准</span>
                <span className="conversation-approval-spinner" aria-hidden="true" />
              </>}
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
  };

  return (
    <aside className="chat-conversations-sidebar" aria-label="会话列表">
      <div className="conversations-actions">
        <div className="conversations-heading"><strong>会话</strong></div>
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
        {assistantSessions.length > 0 && (
          <div className="conversation-assistant-sessions" aria-label="助手会话">
            {assistantSessions.map((session) => renderSessionRow(session))}
          </div>
        )}

        {visibleWorkspaces.map((workspace) => {
          const workspaceSessions = visibleSessions.filter(
            (session) => session.workspaceId === workspace.workspaceId
          );
          const expanded = Boolean(normalizedQuery) || !collapsedWorkspaceIds.has(workspace.workspaceId);
          return (
            <section className="conversation-workspace-group" key={workspace.workspaceId}>
              <div
                className={`conversation-workspace-row${selectedWorkspaceId === workspace.workspaceId ? ' is-selected' : ''}${workspace.pinned ? ' is-pinned' : ''}`}
                data-workspace-id={workspace.workspaceId}
              >
                <button
                  type="button"
                  className="conversation-workspace-main"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '折叠' : '展开'}工作区会话：${workspace.name}`}
                  onClick={() => void toggleWorkspace(workspace.workspaceId)}
                >
                  <Folder size={14} />
                  <span>{workspace.name}</span>
                </button>
                <div className="conversation-workspace-actions" aria-label="工作区操作">
                  <button
                    type="button"
                    className={workspace.pinned ? 'is-pinned' : undefined}
                    aria-label={workspace.pinned ? `取消置顶工作区：${workspace.name}` : `置顶工作区：${workspace.name}`}
                    aria-pressed={workspace.pinned}
                    onClick={() => void services.conversationNavigation
                      .setWorkspacePinned(workspace.workspaceId, !workspace.pinned)
                      .catch((error) => setActionError(errorMessage(error)))}
                  ><Pin size={13} /></button>
                  <button
                    type="button"
                    aria-label={`归档工作区：${workspace.name}`}
                    onClick={() => setArchiveTarget(workspace)}
                  ><Archive size={13} /></button>
                </div>
              </div>
              {workspaceSessions.length > 0 && (
                <div
                  className={`conversation-workspace-sessions${expanded ? '' : ' is-collapsed'}`}
                  role="group"
                  aria-label={`${workspace.name}中的会话`}
                >
                  {workspaceSessions.map((session) => renderSessionRow(session, {
                    collapsedByWorkspace: !expanded,
                    workspaceChild: true
                  }))}
                </div>
              )}
            </section>
          );
        })}

        {runtime.initialized && visibleWorkspaces.length === 0 && visibleSessions.length === 0
          && <p className="conversation-list-empty-state">暂无会话或工作区</p>}
      </div>

      {hovered && hoveredSession && createPortal(
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
        open={archiveTarget !== null}
        title="归档这个工作区？"
        description={archiveTarget
          ? `“${archiveTarget.name}”及其关联会话将从侧栏隐藏。7 天内可在设置中恢复；到期后会永久清理相关聊天、上下文和活动记录。`
          : ''}
        confirmLabel="归档"
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => {
          const target = archiveTarget;
          if (target) void archiveWorkspace(target);
        }}
      />

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
  workspace: ConversationWorkspace | null;
  run: RunSummary | null;
  pinned: boolean;
  top: number;
  left: number;
}): React.JSX.Element {
  return <aside className="conversation-details-popover" role="tooltip" style={{ top, left }}>
    <header><strong>{session.title}</strong><span>{formatRelativeTime(session.updatedAt)}</span></header>
    {workspace && <div><Folder size={13} /><span>{workspace.name}</span></div>}
    <div><Clock3 size={13} /><span>更新于 {formatFullTime(session.updatedAt)}</span></div>
    <div><Pin size={13} /><span>{pinned ? '已置顶' : '普通会话'}</span></div>
    {run && <footer><span className={`conversation-run-dot is-${run.status}`} />{run.userFacingLabel} · {formatRunStatus(run.status)}</footer>}
  </aside>;
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
