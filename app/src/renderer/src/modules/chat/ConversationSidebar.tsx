import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Clock3, Folder, FolderOpen, MessageSquarePlus, Pin, Search, Sparkles } from 'lucide-react';
import { PERSONAL_ASSISTANT_WORKSPACE_ID, type ConversationSession } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { ConversationWorkspace } from '@renderer/core/conversations/conversation-navigation-service';
import { useConversationPresentationRevision } from '@renderer/core/conversations/use-conversation-presentation';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';
import {
  useRuntimeSnapshot,
  type RuntimeRun,
  type RuntimeSnapshot
} from '@renderer/core/runtime/runtime-store';
import { ConfirmDialog, TextPromptDialog } from '@renderer/shared/ui/ActionDialog';

interface ConversationSidebarProps {
  services: ModuleServices;
}

interface HoveredConversation {
  sessionId: string;
  top: number;
  left: number;
}

interface ConversationContextMenuState {
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
  const [archiveWorkspaceTarget, setArchiveWorkspaceTarget] = useState<ConversationWorkspace | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<ConversationSession | null>(null);
  const [archiveSessionTarget, setArchiveSessionTarget] = useState<ConversationSession | null>(null);
  const [contextMenu, setContextMenu] = useState<ConversationContextMenuState | null>(null);
  const [hovered, setHovered] = useState<HoveredConversation | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const presentationRevision = useConversationPresentationRevision(services.conversationNavigation);

  useEffect(() => {
    let active = true;
    const applyCatalog = (catalog: readonly ConversationWorkspace[]): void => {
      if (!active) return;
      setWorkspaces(catalog);
      void services.runtime.refresh().catch(() => undefined);
    };
    const applySelection = (workspaceId: string | null): void => {
      if (active) setSelectedWorkspaceId(workspaceId);
    };
    const unsubscribeCatalog = services.conversationNavigation.onWorkspacesChanged(applyCatalog);
    const unsubscribeSelection = services.conversationNavigation.onSelectedWorkspaceChanged(applySelection);
    void services.conversationNavigation.listWorkspaces().then(applyCatalog).catch(() => undefined);
    return () => {
      active = false;
      unsubscribeCatalog();
      unsubscribeSelection();
    };
  }, [services]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(
    () => runtime.sessions
      .filter((session) => session.status === 'active')
      .filter((session) => session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID
        || services.conversationNavigation.isWorkspaceActive(session.workspaceId))
      .filter((session) => !normalizedQuery || session.title
        .toLocaleLowerCase()
        .includes(normalizedQuery))
      .sort((left, right) => {
        const pinDifference = Number(
          services.conversationNavigation.isSessionPinned(right.sessionId, right.pinned)
        ) - Number(
          services.conversationNavigation.isSessionPinned(left.sessionId, left.pinned)
        );
        return pinDifference || right.updatedAt.localeCompare(left.updatedAt);
      }),
    [normalizedQuery, presentationRevision, runtime.sessions, services, workspaces]
  );
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !normalizedQuery
      || workspace.name.toLocaleLowerCase().includes(normalizedQuery)
      || workspace.rootPath.toLocaleLowerCase().includes(normalizedQuery)
      || visibleSessions.some((session) => session.workspaceId === workspace.workspaceId)),
    [normalizedQuery, visibleSessions, workspaces]
  );
  const assistantSessions = useMemo(
    () => visibleSessions.filter((session) => session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID),
    [visibleSessions]
  );
  const pendingSessionIds = useMemo(
    () => pendingApprovalSessionIds(runtime),
    [runtime.permissions, runtime.planHandoffs, runtime.userQuestions, runtime.runs]
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
    services.conversationNavigation.setSessionUnread(session.sessionId, false);
    if (session.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID) {
      services.conversationNavigation.selectAssistant();
    } else {
      void services.conversationNavigation.selectWorkspace(session.workspaceId);
    }
    void services.runtime.selectSession(session.sessionId).catch((error) => {
      setActionError(errorMessage(error));
    });
  };

  const startNewDraft = async (): Promise<void> => {
    setActionError(null);
    try {
      const workspaceId = selectedWorkspaceId
        ?? services.conversationNavigation.getSelectedWorkspaceId();
      if (workspaceId) await services.conversationNavigation.selectWorkspace(workspaceId);
      else services.conversationNavigation.selectAssistant();
      services.runtime.clearSessionSelection();
      services.events.emit('chat:new-draft-requested', { workspaceId });
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
      services.runtime.clearSessionSelection();
      services.events.emit('chat:new-draft-requested', { workspaceId: opened.workspaceId });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const archiveWorkspace = async (workspace: ConversationWorkspace): Promise<void> => {
    setArchiveWorkspaceTarget(null);
    setActionError(null);
    try {
      await services.conversationNavigation.archiveWorkspace(workspace.workspaceId);
      if (selectedWorkspaceId === workspace.workspaceId) {
        services.runtime.clearSessionSelection();
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const renameSession = async (session: ConversationSession, title: string): Promise<void> => {
    setRenameSessionTarget(null);
    setActionError(null);
    try {
      await services.runtime.renameSession(session, title);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const archiveSession = async (session: ConversationSession): Promise<void> => {
    setArchiveSessionTarget(null);
    setActionError(null);
    try {
      await services.runtime.archiveSession(session);
      if (runtime.selectedSessionId === session.sessionId) services.runtime.clearSessionSelection();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const openContextMenu = (event: MouseEvent<HTMLDivElement>, session: ConversationSession): void => {
    event.preventDefault();
    setHovered(null);
    const width = 176;
    const height = 152;
    setContextMenu({
      sessionId: session.sessionId,
      left: Math.min(event.clientX, window.innerWidth - width - 8),
      top: Math.min(event.clientY, window.innerHeight - height - 8)
    });
  };

  const showDetails = (event: MouseEvent<HTMLDivElement>, session: ConversationSession): void => {
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
    const unread = services.conversationNavigation.isSessionUnread(session.sessionId);
    const title = session.title;
    const waitingForApproval = pendingSessionIds.has(session.sessionId);
    return (
      <div
        className={`conversation-row${runtime.selectedSessionId === session.sessionId ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}${unread ? ' is-unread' : ''}${waitingForApproval ? ' has-pending-approval' : ''}${workspaceChild ? ' is-workspace-child' : ''}${collapsedByWorkspace ? ' is-workspace-collapsed' : ''}`}
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
        onContextMenu={(event) => openContextMenu(event, session)}
      >
        <div
          className="conversation-row-main"
          role="button"
          tabIndex={collapsedByWorkspace ? -1 : 0}
          aria-current={runtime.selectedSessionId === session.sessionId ? 'page' : undefined}
          onClick={() => selectSession(session)}
          onKeyDown={(event) => selectSessionFromKeyboard(event, () => selectSession(session))}
        >
          <span className="conversation-title">
            {unread && <span className="conversation-unread-marker" aria-label="未读" />}
            <span className="conversation-title-text">{title}</span>
            {waitingForApproval && <>
              <span className="conversation-approval-badge">等待批准</span>
              <span className="conversation-approval-spinner" aria-hidden="true" />
            </>}
            {pinned && <Pin className="conversation-pinned-marker" size={11} aria-label="已置顶" />}
          </span>
        </div>
        <div className="conversation-row-actions" aria-label="会话操作">
          <button
            type="button"
            className={pinned ? 'is-pinned' : undefined}
            aria-label={pinned ? `取消置顶：${title}` : `置顶会话：${title}`}
            aria-pressed={pinned}
            onClick={() => {
              services.conversationNavigation.setSessionPinned(session.sessionId, !pinned);
            }}
          ><Pin size={12} /></button>
        </div>
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
            onClick={() => void startNewDraft()}
          ><MessageSquarePlus size={14} /><span>新建会话</span></button>
        </div>
        {actionError && <p className="conversation-action-error" role="alert">{actionError}</p>}
        <label className="conversation-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
        </label>
      </div>

      <div className="conversation-groups">
        <section className="conversation-workspace-group">
          <div
            className={`conversation-workspace-row${selectedWorkspaceId === null ? ' is-selected' : ''}`}
            data-workspace-id={PERSONAL_ASSISTANT_WORKSPACE_ID}
          >
            <button
              type="button"
              className="conversation-workspace-main"
              aria-expanded={!collapsedWorkspaceIds.has(PERSONAL_ASSISTANT_WORKSPACE_ID)}
              aria-label="个人助手会话"
              onClick={() => {
                services.conversationNavigation.selectAssistant();
                services.runtime.clearSessionSelection();
                setCollapsedWorkspaceIds((current) => {
                  const next = new Set(current);
                  if (next.has(PERSONAL_ASSISTANT_WORKSPACE_ID)) next.delete(PERSONAL_ASSISTANT_WORKSPACE_ID);
                  else next.add(PERSONAL_ASSISTANT_WORKSPACE_ID);
                  return next;
                });
              }}
            >
              <Sparkles size={14} />
              <span>个人助手</span>
            </button>
          </div>
          {assistantSessions.length > 0 && (
            <div
              className={`conversation-workspace-sessions${collapsedWorkspaceIds.has(PERSONAL_ASSISTANT_WORKSPACE_ID) ? ' is-collapsed' : ''}`}
              role="group"
              aria-label="个人助手中的会话"
            >
              {assistantSessions.map((session) => renderSessionRow(session, {
                collapsedByWorkspace: collapsedWorkspaceIds.has(PERSONAL_ASSISTANT_WORKSPACE_ID),
                workspaceChild: true
              }))}
            </div>
          )}
        </section>

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
                    onClick={() => setArchiveWorkspaceTarget(workspace)}
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

      </div>

      {contextMenu && (() => {
        const session = runtime.sessions.find((candidate) => candidate.sessionId === contextMenu.sessionId);
        if (!session) return null;
        const pinned = services.conversationNavigation.isSessionPinned(session.sessionId, session.pinned);
        const unread = services.conversationNavigation.isSessionUnread(session.sessionId);
        return createPortal(
          <ConversationContextMenu
            top={contextMenu.top}
            left={contextMenu.left}
            pinned={pinned}
            unread={unread}
            onClose={() => setContextMenu(null)}
            onTogglePinned={() => services.conversationNavigation.setSessionPinned(session.sessionId, !pinned)}
            onRename={() => setRenameSessionTarget(session)}
            onArchive={() => setArchiveSessionTarget(session)}
            onToggleUnread={() => services.conversationNavigation.setSessionUnread(session.sessionId, !unread)}
          />,
          document.body
        );
      })()}

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
        open={archiveWorkspaceTarget !== null}
        title="归档这个工作区？"
        description={archiveWorkspaceTarget
          ? `“${archiveWorkspaceTarget.name}”及其关联会话将从侧栏隐藏。可随时在设置中恢复，归档不会删除会话数据。`
          : ''}
        confirmLabel="归档"
        onClose={() => setArchiveWorkspaceTarget(null)}
        onConfirm={() => {
          const target = archiveWorkspaceTarget;
          if (target) void archiveWorkspace(target);
        }}
      />

      <TextPromptDialog
        open={renameSessionTarget !== null}
        title="重命名聊天"
        description="修改这个聊天在侧栏和标题栏中显示的名称。"
        initialValue={renameSessionTarget
          ? renameSessionTarget.title
          : ''}
        confirmLabel="保存"
        onClose={() => setRenameSessionTarget(null)}
        onConfirm={(title) => {
          if (renameSessionTarget) void renameSession(renameSessionTarget, title);
        }}
      />

      <ConfirmDialog
        open={archiveSessionTarget !== null}
        title="归档聊天？"
        description={archiveSessionTarget
          ? `“${archiveSessionTarget.title}”将从侧栏隐藏，但会话和消息数据不会删除。`
          : ''}
        confirmLabel="归档聊天"
        onClose={() => setArchiveSessionTarget(null)}
        onConfirm={() => {
          const target = archiveSessionTarget;
          if (!target) return;
          void archiveSession(target);
        }}
      />

    </aside>
  );
}

function ConversationContextMenu({
  top,
  left,
  pinned,
  unread,
  onClose,
  onTogglePinned,
  onRename,
  onArchive,
  onToggleUnread
}: {
  top: number;
  left: number;
  pinned: boolean;
  unread: boolean;
  onClose(): void;
  onTogglePinned(): void;
  onRename(): void;
  onArchive(): void;
  onToggleUnread(): void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    const dismissFromWindow = (): void => onClose();
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', dismissFromWindow);
    window.addEventListener('resize', dismissFromWindow);
    window.addEventListener('scroll', dismissFromWindow, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', dismissFromWindow);
      window.removeEventListener('resize', dismissFromWindow);
      window.removeEventListener('scroll', dismissFromWindow, true);
    };
  }, [onClose]);

  const run = (action: () => void): void => {
    action();
    onClose();
  };

  return <div
    ref={menuRef}
    className="conversation-context-menu"
    role="menu"
    aria-label="聊天操作"
    style={{ top, left }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + direction + items.length) % items.length]?.focus();
    }}
  >
    <button type="button" role="menuitem" onClick={() => run(onTogglePinned)}>{pinned ? '取消置顶聊天' : '置顶聊天'}</button>
    <button type="button" role="menuitem" onClick={() => run(onRename)}>重命名聊天</button>
    <button type="button" role="menuitem" onClick={() => run(onArchive)}>归档聊天</button>
    <button type="button" role="menuitem" onClick={() => run(onToggleUnread)}>{unread ? '标记为已读' : '标记为未读'}</button>
  </div>;
}

function ConversationDetailsPopover({ session, workspace, run, pinned, top, left }: {
  session: ConversationSession;
  workspace: ConversationWorkspace | null;
  run: RuntimeRun | null;
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

function selectSessionFromKeyboard(event: KeyboardEvent<HTMLDivElement>, select: () => void): void {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  select();
}

function latestSessionRun(runs: readonly RuntimeRun[], sessionId: string): RuntimeRun | null {
  return runs
    .filter((run) => run.sessionId === sessionId)
    .sort((left, right) => (right.startedAt ?? right.completedAt ?? '').localeCompare(left.startedAt ?? left.completedAt ?? ''))[0]
    ?? null;
}

function pendingApprovalSessionIds(snapshot: RuntimeSnapshot): Set<string> {
  const runSessions = new Map(snapshot.runs.flatMap((run) => (
    run.sessionId === undefined ? [] : [[run.runId, run.sessionId] as const]
  )));
  const ids = new Set<string>();
  for (const decision of [
    ...snapshot.permissions,
    ...snapshot.planHandoffs,
    ...snapshot.userQuestions
  ]) {
    if (decision.status !== 'pending') continue;
    const sessionId = decision.sessionId
      ?? (decision.runId === undefined ? undefined : runSessions.get(decision.runId));
    if (sessionId !== undefined) ids.add(sessionId);
  }
  return ids;
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
