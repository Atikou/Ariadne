import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('Chat module composition', () => {
  it('owns the conversation sidebar instead of registering a separate conversations panel', async () => {
    const [chat, sidebar, registry, moduleIds] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'core', 'modules', 'builtin-modules.ts'), 'utf8'),
      readFile(join(rendererRoot, 'core', 'modules', 'module-ids.ts'), 'utf8')
    ]);

    expect(chat).toContain('<ConversationSidebar services={services} />');
    expect(sidebar).toContain('className="chat-conversations-sidebar"');
    expect(sidebar).toContain('await services.runtime.createSession({');
    expect(sidebar).toContain('selectSession(session)');
    expect(sidebar).toContain('services.runtime.renameSession(session.sessionId, nextTitle)');
    expect(sidebar).toContain('services.runtime.deleteSession(target.sessionId)');
    expect(sidebar).toContain('services.conversationNavigation.listWorkspaces()');
    expect(sidebar).toContain('services.conversationNavigation.openWorkspace()');
    expect(sidebar).toContain('services.conversationNavigation.selectWorkspace(workspaceId)');
    expect(sidebar).toContain("'打开工作区'");
    expect(sidebar).toContain('<span>新建会话</span>');
    expect(sidebar).toContain('selectedWorkspaceId ? { workspaceId: selectedWorkspaceId }');
    expect(chat).toContain('const workspaceId = selectedSession?.workspaceId');
    expect(registry).not.toContain('conversationsModule');
    expect(moduleIds).not.toContain('conversations.list');
  });

  it('renders assistant sessions first and nests workspace sessions under their workspace', async () => {
    const [sidebar, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(sidebar).toContain('assistantSessions');
    expect(sidebar.indexOf('{assistantSessions.length > 0')).toBeLessThan(
      sidebar.indexOf('{visibleWorkspaces.map((workspace) =>')
    );
    expect(sidebar).toContain('services.conversationNavigation.isAssistantWorkspace(session.workspaceId)');
    expect(sidebar).toContain('conversation-assistant-sessions');
    expect(sidebar).toContain('conversation-workspace-group');
    expect(sidebar).toContain('conversation-workspace-sessions');
    expect(sidebar).toContain("workspaceChild ? ' is-workspace-child' : ''");
    expect(sidebar).toContain('pendingApprovalSessionIds(runtime)');
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
    expect(sidebar).toContain('onDoubleClick={(event) =>');
    expect(sidebar).toContain('className="conversation-title-input"');
    expect(sidebar).toContain('setSessionPinned(session.sessionId, !pinned)');
    expect(sidebar).toContain('createPortal(');
    expect(sidebar).toContain('role="tooltip"');
    expect(sidebar).not.toContain('TextPromptDialog');
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

  it('gives the Chat content its own clipped rounded boundary beside the conversation sidebar', async () => {
    const styles = await readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.chat-panel\s*\{[^}]*background:\s*var\(--bg-1\);/);
    expect(styles).toMatch(/\.chat-conversation\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid var\(--border-strong\);[^}]*border-right:\s*0;[^}]*border-radius:\s*var\(--radius-lg\) 0 0 var\(--radius-lg\);/);
  });

  it('renders custom select menus in a viewport-aware portal with compact options', async () => {
    const [selectMenu, styles] = await Promise.all([
      readFile(join(rendererRoot, 'shared', 'ui', 'SelectMenu.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(selectMenu).toContain('createPortal(<>{popover}{submenu}</>, document.body)');
    expect(selectMenu).toContain('calculateSelectMenuLayout');
    expect(selectMenu).toContain('calculateSelectSubmenuLayout');
    expect(selectMenu).toContain("onMouseEnter={() => {");
    expect(selectMenu).toContain("document.addEventListener('scroll', scheduleUpdate, true)");
    expect(styles).toMatch(/\.select-menu-popover\s*\{[^}]*position:\s*fixed;[^}]*overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.select-menu-option\s*\{[^}]*min-height:\s*30px;[^}]*padding:\s*4px 7px;/);
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
    expect(chat).toContain("value: 'full-access'");
    expect(chat).toContain('自定义 (settings.toml)');
    expect(chat).toContain("routingStrategy,");
    expect(chat).toContain("const AUTO_MODEL_ID = '__auto__';");
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
    expect(chat).toContain('calculateComposerTextareaLayout(');
    expect(styles).toMatch(/\.composer \{[^}]*border-radius:\s*var\(--radius-lg\);/);
    expect(styles).toMatch(/\.composer textarea \{[^}]*overflow-y:\s*hidden;[^}]*min-height:\s*49px;[^}]*max-height:\s*144px;/);
  });

  it('uses a filled circular stop control while a run is active', async () => {
    const [chat, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).toContain('<span className="send-stop-glyph" aria-hidden="true" />');
    expect(chat).not.toContain('CircleStop');
    expect(styles).toMatch(/\.send-button--stop,[^{]+?\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*background:\s*#17181c;[^}]*border-radius:\s*50%;/);
    expect(styles).toMatch(/\.send-stop-glyph\s*\{[^}]*width:\s*11px;[^}]*height:\s*11px;[^}]*background:\s*currentColor;/);
  });

  it('shows turn-level waiting and failure states in Chat while keeping global Runtime failures in Logs', async () => {
    const [chat, logs, styles] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'logs', 'LogsPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8')
    ]);

    expect(chat).not.toContain('runtime.lastError');
    expect(chat).not.toContain('composer-error');
    expect(chat).toContain("message.status === 'streaming' ? '正在处理…' : ''");
    expect(chat).toContain('<RunProcessingDisclosure');
    expect(styles).toMatch(/\.run-processing-disclosure\s*\{/);
    expect(chat).toContain("node.error?.message ?? (node.status === 'failed'");
    expect(styles).toMatch(/\.message-status-notice\s*\{/);
    expect(logs).toContain("useState<LogViewFilter>('important')");
    expect(logs).toContain('traceMatchesView(entry, view)');
    expect(logs).toContain('coalesceTraceLogs(');
    expect(logs).toContain("entry.level === 'error' ? ' is-error'");
    expect(styles).not.toContain('.composer-error');
    expect(styles).toMatch(/\.log-row\.is-error\s+svg,\s*\.log-row\.is-error\s+p\s*\{[^}]*color:\s*var\(--danger\);/);
  });

  it('invalidates persisted layouts that still contain the removed conversations panel', async () => {
    const workspace = await readFile(join(rendererRoot, 'app', 'Workspace.tsx'), 'utf8');
    expect(workspace).toContain('const LAYOUT_REVISION = 3;');
  });
});
