import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_MODEL_ID, permissionModeOptions } from '../src/renderer/src/modules/chat/ChatComposerPolicy';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('Chat module composition', () => {
  it('owns the conversation sidebar instead of registering a separate conversations panel', async () => {
    const [chat, sidebar, registry] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'core', 'modules', 'UiComponentCatalog.generated.ts'), 'utf8')
    ]);

    expect(chat).toContain('<ConversationSidebar services={services} />');
    expect(sidebar).toContain('className="chat-conversations-sidebar"');
    expect(sidebar).not.toContain('services.runtime.createSession(');
    expect(sidebar).toContain("services.events.emit('chat:new-draft-requested'");
    expect(sidebar).toContain('services.sessions.clearSelection()');
    expect(sidebar).toContain('selectSession(session)');
    expect(sidebar).toContain('services.sessions.rename(session, title)');
    expect(sidebar).not.toContain('services.conversationNavigation.renameSession(');
    expect(sidebar).not.toContain('services.runtime.deleteSession(');
    expect(sidebar).toContain('services.conversationNavigation.listWorkspaces()');
    expect(sidebar).toContain('services.conversationNavigation.openWorkspace()');
    expect(sidebar).toContain('services.conversationNavigation.selectWorkspace(workspaceId)');
    expect(sidebar).toContain("'打开工作区'");
    expect(sidebar).toContain('<span>新建会话</span>');
    expect(sidebar).toContain('services.conversationNavigation.getSelectedWorkspaceId()');
    expect(chat).toContain('className="composer-context-bar"');
    expect(chat).toContain('className="composer-workspace-menu"');
    expect(chat).toContain('services.conversationNavigation.listSelectableWorkspaces()');
    expect(chat).toContain('workspaceId: composerWorkspaceId');
    expect(chat).toContain("services.events.subscribe('chat:new-draft-requested'");
    expect(registry).not.toContain('conversationsModule');
    expect(chat).not.toContain('conversations.list');
  });

  it('separates personal-assistant sessions from Agent workspace sessions', async () => {
    const [sidebar, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(sidebar).toContain('assistantSessions');
    expect(sidebar).toContain('PERSONAL_ASSISTANT_WORKSPACE_ID');
    expect(sidebar).toContain('services.conversationNavigation.selectAssistant()');
    expect(sidebar).toContain('<span>个人助手</span>');
    expect(sidebar).toContain('conversation-workspace-group');
    expect(sidebar).toContain('conversation-workspace-sessions');
    expect(sidebar).toContain("workspaceChild ? ' is-workspace-child' : ''");
    expect(sidebar).toContain('pendingApprovalSessionIds(runtime)');
    expect(sidebar).not.toContain('materializedSessionIds.has(session.sessionId)');
    expect(sidebar).toContain('pendingSessionIds.has(session.sessionId)');
    expect(sidebar).toContain('<span className="conversation-approval-badge">等待批准</span>');
    expect(sidebar).toContain('className="conversation-approval-spinner"');
    expect(sidebar).toContain('conversation-workspace-row');
    expect(sidebar).toContain('conversation-workspace-main');
    expect(sidebar).toContain('conversation-workspace-actions');
    expect(sidebar).toContain('<Archive size={13} />');
    expect(sidebar).toContain('setWorkspacePinned(workspace.workspaceId, !workspace.pinned)');
    expect(sidebar).not.toContain('<small>{sessions.length}</small>');
    expect(sidebar).toContain('collapsedWorkspaceIds');
    expect(sidebar).toContain('aria-expanded={expanded}');
    expect(sidebar).toContain('is-workspace-collapsed');
    expect(sidebar).toContain('height: 0');
    expect(sidebar).toContain('borderWidth: 0');
    expect(sidebar).toContain("transform: 'translateY(-5px) scaleY(.92)'");
    expect(sidebar).not.toContain('ChevronRight');
    expect(sidebar).not.toContain('onDoubleClick={(event) =>');
    expect(sidebar).not.toContain('className="conversation-title-input"');
    expect(sidebar).toContain('setSessionPinned(session.sessionId, !pinned)');
    expect(sidebar).toContain('createPortal(');
    expect(sidebar).toContain('role="tooltip"');
    expect(sidebar).toContain('TextPromptDialog');
    expect(sidebar).toContain('onContextMenu={(event) => openContextMenu(event, session)}');
    expect(sidebar).toContain('className="conversation-context-menu"');
    expect(sidebar).toContain('role="menu"');
    expect(sidebar).toContain('置顶聊天');
    expect(sidebar).toContain('重命名聊天');
    expect(sidebar).toContain('归档聊天');
    expect(sidebar).toContain('标记为未读');
    expect(sidebar).toContain('services.sessions.archive(session)');
    expect(sidebar).not.toContain('services.conversationNavigation.archiveSession(');
    expect(sidebar).not.toContain('materializedSessionIds');
    expect(sidebar).not.toContain('runtime.messages.map');
    expect(sidebar).toContain('services.conversationNavigation.setSessionUnread');
    expect(sidebar).not.toContain('Pencil');
    expect(sidebar).not.toContain('conversation-meta');
    expect(styles).toMatch(/\.conversation-row\s*\{[^}]*height:\s*30px;/);
    expect(styles).toMatch(/\.conversation-workspace-row\s*\{[^}]*min-height:\s*30px;/);
    expect(styles).toMatch(/\.conversation-row\s*\{[^}]*transition:\s*height 180ms/);
    expect(styles).toMatch(/\.conversation-workspace-sessions\s*\{[^}]*margin:\s*1px 0 4px 18px;[^}]*padding-left:\s*8px;[^}]*border-left:\s*1px solid var\(--border-subtle\);/);
    expect(styles).toMatch(/\.conversation-approval-badge\s*\{[^}]*color:\s*var\(--success\);[^}]*border-radius:\s*var\(--radius-lg\);/);
    expect(styles).toMatch(/\.conversation-approval-spinner\s*\{[^}]*width:\s*10px;[^}]*border-radius:\s*50%;[^}]*animation:\s*conversation-approval-spin/);
    expect(styles).not.toContain('.conversation-workspace-chevron');
    expect(styles).toMatch(/\.conversation-details-popover\s*\{[^}]*position:\s*fixed;/);
  });

  it('separates the sidebar without nesting another rounded frame inside Chat', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.chat-panel\s*\{[^}]*background:\s*var\(--bg-1\);/);
    expect(styles).toMatch(/\.chat-sidebar-slot\s*\{[^}]*border-right:\s*1px solid var\(--border-subtle\);/);
    expect(styles).toMatch(/\.chat-conversation\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*0;[^}]*border-radius:\s*0;/);
  });

  it('renders custom select menus in a viewport-aware portal with compact options', async () => {
    const [selectMenu, styles] = await Promise.all([
      readFile(join(rendererRoot, 'shared', 'ui', 'SelectMenu.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    // Parent-modal ownership and keyboard containment are exercised in renderer-ui-smoke.
    expect(selectMenu).toContain('createPortal(');
    expect(selectMenu).toContain('calculateSelectMenuLayout');
    expect(selectMenu).toContain('calculateSelectSubmenuLayout');
    expect(selectMenu).toContain("onMouseEnter={() => {");
    expect(styles).toMatch(/\.select-menu-popover\s*\{[^}]*position:\s*fixed;[^}]*overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.select-menu-option\s*\{[^}]*min-height:\s*34px;[^}]*padding:\s*6px 9px;/);
    expect(styles).toMatch(/\.select-menu-trigger:focus-visible\s*\{[^}]*border-color:\s*var\(--accent\);[^}]*box-shadow:/);
  });

  it('nests routing under automatic model selection and keeps permission modes at the right edge', async () => {
    const [chat, settings, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).not.toContain('className="composer-runtime-controls"');
    expect(chat).toContain('className="composer-model-controls"');
    expect(chat).not.toContain('className="composer-routing-menu"');
    expect(chat).toContain('children: routingOptions.map');
    expect(chat).toContain('parseRoutingSelectionValue(nextValue)');
    expect(chat).toContain('value={modelSelectionValue}');
    expect(chat).toContain('className="composer-action-controls"');
    expect(chat).toContain('className="composer-permission-mode-menu"');
    expect(permissionModeOptions.map(option => option.value)).toContain('full-access');
    expect(permissionModeOptions.find(option => option.value === 'custom')?.label).toBe('自定义 (settings.toml)');
    expect(chat).toContain("routingStrategy,");
    expect(AUTO_MODEL_ID).toBe('__auto__');
    expect(chat).toContain('services.agentSettings.apply({');
    expect(chat).toContain('expectedRevision: settings.revision');
    expect(chat).toContain("operations: [{ kind: 'permissions.set', mode: nextPermissionMode }]");
    expect(chat).not.toContain("kind: 'provider.update'");
    expect(settings).toContain('expectedRevision: baseline.revision');
    expect(settings).toContain("operations.push({ kind: 'provider.update', providerId: id, patch })");
    expect(settings).not.toContain("kind: 'permissions.set'");
    expect(chat).toContain("services.events.emit('chat:workspace-access-changed', saved.workspaceAccess)");
    expect(chat).not.toContain('AgentProposalCard');
    expect(settings).not.toContain('<span>工作区访问</span>');
    expect(settings).not.toContain('<span>路由策略</span>');
    expect(styles).toMatch(/\.composer-model-controls\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(styles).toMatch(/\.composer-action-controls\s*\{[^}]*justify-content:\s*flex-end;[^}]*gap:\s*7px;/);
    expect(styles).toMatch(/\.composer-permission-mode-menu \.select-menu-trigger\s*\{[^}]*border-color:\s*transparent;/);
    expect(styles).toMatch(/\.composer-permission-mode-menu \.select-menu-trigger\[data-tone="warning"\]\s*\{[^}]*border-color:\s*transparent;/);
  });

  it('auto-grows the composer until its height cap and then scrolls internally', async () => {
    const [chat, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).toContain('ref={composerInputRef}');
    expect(chat).toContain('syncComposerTextareaHeight(composerInputRef.current)');
    expect(chat).toContain('observer.observe(composer)');
    expect(styles).toMatch(/\.composer \{[^}]*border-radius:\s*var\(--radius-lg\);/);
    expect(styles).toMatch(/\.composer textarea \{[^}]*overflow-y:\s*hidden;[^}]*min-height:\s*49px;[^}]*max-height:\s*144px;/);
  });

  it('keeps the stop control on the shared composer-control geometry while a run is active', async () => {
    const [chat, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).toContain('<span className="send-stop-glyph" aria-hidden="true" />');
    expect(chat).not.toContain('CircleStop');
    expect(styles).toMatch(/\.composer-mic-button, \.send-button \{[^}]*width:\s*29px;[^}]*height:\s*29px;[^}]*flex:\s*0 0 29px;/);
    expect(styles).toMatch(/\.composer-mic-button, \.send-button \{[^}]*box-sizing:\s*border-box;[^}]*border-radius:\s*var\(--radius-md\);[^}]*box-shadow:\s*none;/);
    expect(styles).toMatch(/\.send-button--stop,[^{]+?\{[^}]*background:\s*#17181c;/);
    expect(styles).not.toMatch(/\.send-button--stop[^{}]*\{[^}]*(?:width|height|border-radius|box-shadow|transform):/);
    expect(styles).toMatch(/\.send-stop-glyph\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;[^}]*background:\s*currentColor;/);
  });

  it('shows turn-level waiting and failure states in Chat while keeping global Runtime failures in Logs', async () => {
    const [chat, logs, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'logs', 'LogsPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).not.toContain('runtime.lastError');
    expect(chat).not.toContain('composer-error');
    // Message waiting, partial content and failures are asserted by message-actions rendering tests.
    expect(chat).toContain('<ConversationMessageRow');
    expect(styles).toMatch(/\.run-processing-disclosure\s*\{/);
    expect(styles).toMatch(/\.message-status-notice\s*\{/);
    expect(logs).toContain("useState<LogViewFilter>('important')");
    expect(logs).toContain('traceMatchesView(entry, view)');
    expect(logs).toContain('coalesceTraceLogs(');
    expect(logs).toContain("entry.level === 'error' ? ' is-error'");
    expect(styles).not.toContain('.composer-error');
    const logStyles = await readFile(join(rendererRoot, 'modules', 'logs', 'logs.css'), 'utf8');
    expect(logStyles).toMatch(/\.log-row\.is-error\s+svg,\s*\.log-row\.is-error\s+p\s*\{[^}]*color:\s*var\(--danger\);/);
  });

  it('invalidates persisted layouts that still contain the removed conversations panel', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');
    expect(workspace).toContain('const LAYOUT_REVISION = 3;');
  });
});
