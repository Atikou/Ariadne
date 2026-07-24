import { app, BrowserWindow } from 'electron';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

interface SmokeObservation {
  documentTitle: string;
  rootWidth: number;
  rootHeight: number;
  runtimeStatus: string;
  runtimeDetail: string | null;
  runtimeBridge: boolean;
  agentSettingsBridge: boolean;
  runtimeUiReady: boolean;
  chatComposed: boolean;
  chatConversationRounded: boolean;
  chatConversationBoundaryMetrics: {
    borderTopLeftRadius: string;
    borderBottomLeftRadius: string;
    borderTopWidth: string;
    borderBottomWidth: string;
    borderLeftWidth: string;
    borderRightWidth: string;
    overflow: string;
  } | null;
  chatMessageTextFidelity: boolean;
  chatMessageTextMetrics: {
    exactTextPreserved: boolean;
    whiteSpace: string;
    singleLineWidth: number;
    singleLineHeight: number;
    multilineHeight: number;
    expectedLineBox: number;
  } | null;
  chatReplyRightBounded: boolean;
  chatReplyBoundaryMetrics: {
    userMessageRight: number;
    assistantMessageRight: number;
    markdownRight: number;
    codeBlockRight: number;
    assistantOverflowX: string;
    codeBlockOverflowX: string;
  } | null;
  composerEnabled: boolean;
  composerGuarded: boolean;
  composerControlsVisible: boolean;
  composerRoutingNested: boolean;
  composerPermissionModeRightAligned: boolean;
  readyModelCount: number;
  selectMenuViewportFit: boolean;
  selectMenuCompact: boolean;
  selectMenuMetrics: {
    triggerFound: boolean;
    popoverFound: boolean;
    parentIsBody: boolean;
    visibility: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    optionHeights: number[];
  };
  workspaceOpenButtonVisible: boolean;
  newSessionButtonVisible: boolean;
  workspaceFileContextBound: boolean;
  workspaceFileAuthorizationEnforced: boolean;
  terminalWorkspaceContextBound: boolean;
  terminalWorkspaceAuthorizationEnforced: boolean;
  sessionCreated: boolean;
  sessionCreatedInCurrentWorkspace: boolean;
  workspaceConversationTreeReady: boolean;
  workspaceCollapseWorks: boolean;
  compactConversationRows: boolean;
  conversationDetailsPopoverWorks: boolean;
  conversationInlineRenameWorks: boolean;
  conversationPinWorks: boolean;
  settingsUiReady: boolean;
  settingsNoDynamicRuntimeControls: boolean;
  providerCardCount: number;
  collapsedProviderCardCount: number;
  providerDisclosureWorks: boolean;
  narrowSettingsLayoutFits: boolean;
  logsLayoutNoOverlap: boolean;
  logsLayoutMetrics: {
    categoryRight: number;
    messageLeft: number;
    gap: number;
    categoryOverflow: string;
    categoryTextOverflow: string;
  } | null;
}

interface PopoutObservation {
  created: boolean;
  rendered: boolean;
  privilegedBridgeAbsent: boolean;
  themeMatchesMain: boolean;
  liveThemeSyncWorks: boolean;
  returnedToMainWindow: boolean;
  untrustedWindowDenied: boolean;
}

interface LiveTraceObservation {
  eventReceived: boolean;
  panelRendered: boolean;
  category: string | null;
  message: string | null;
  level: string | null;
  metadataVisible: boolean;
  errorPanelRendered: boolean;
  errorMessage: string | null;
  errorMetadataVisible: boolean;
}

export async function runElectronSmokeTest(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  if (!isAbsolute(outputRoot)) throw new Error('ARIADNE_SMOKE_TEST_OUTPUT must be absolute.');
  await mkdir(outputRoot, { recursive: true });
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      window.webContents.once('did-finish-load', () => resolve());
      window.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`Renderer load failed (${code}): ${description}`));
      });
    });
  }

  const consoleErrors: string[] = [];
  const onConsoleMessage = (
    _details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    level: number,
    message: string
  ): void => {
    if (level === 3) consoleErrors.push(message.slice(0, 512));
  };
  window.webContents.on('console-message', onConsoleMessage);

  try {
    const observation = await waitForRendererReady(window);
    const liveTraceObservation = await verifyLiveTracePanel(window);
    const popoutObservation = await verifyDockviewPopout(window);
    const settingsTomlCreated = await fileExists(join(app.getPath('userData'), 'settings.toml'));
    window.setSkipTaskbar(true);
    window.setPosition(-10_000, -10_000, false);
    window.showInactive();
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
    const screenshot = await window.webContents.capturePage();
    window.hide();
    const screenshotPath = join(outputRoot, 'electron-runtime-smoke.png');
    await writeFile(screenshotPath, screenshot.toPNG());
    const passed = observation.documentTitle === 'Ariadne'
      && observation.rootWidth >= 640
      && observation.rootHeight >= 480
      && observation.runtimeStatus === 'ready'
      && observation.runtimeBridge
      && observation.agentSettingsBridge
      && observation.runtimeUiReady
      && observation.chatComposed
      && observation.chatConversationRounded
      && observation.chatMessageTextFidelity
      && observation.chatReplyRightBounded
      && observation.composerGuarded
      && observation.composerControlsVisible
      && observation.composerRoutingNested
      && observation.composerPermissionModeRightAligned
      && observation.selectMenuViewportFit
      && observation.selectMenuCompact
      && observation.workspaceOpenButtonVisible
      && observation.newSessionButtonVisible
      && observation.workspaceFileContextBound
      && observation.workspaceFileAuthorizationEnforced
      && observation.terminalWorkspaceContextBound
      && observation.terminalWorkspaceAuthorizationEnforced
      && observation.sessionCreated
      && observation.sessionCreatedInCurrentWorkspace
      && observation.workspaceConversationTreeReady
      && observation.workspaceCollapseWorks
      && observation.compactConversationRows
      && observation.conversationDetailsPopoverWorks
      && observation.conversationInlineRenameWorks
      && observation.conversationPinWorks
      && observation.settingsUiReady
      && observation.settingsNoDynamicRuntimeControls
      && observation.providerCardCount === 4
      && observation.collapsedProviderCardCount === 4
      && observation.providerDisclosureWorks
      && observation.narrowSettingsLayoutFits
      && observation.logsLayoutNoOverlap
      && liveTraceObservation.eventReceived
      && liveTraceObservation.panelRendered
      && liveTraceObservation.category === 'companion.turn.input'
      && liveTraceObservation.level === 'info'
      && liveTraceObservation.metadataVisible
      && liveTraceObservation.errorPanelRendered
      && Boolean(liveTraceObservation.errorMessage)
      && liveTraceObservation.errorMetadataVisible
      && popoutObservation.created
      && popoutObservation.rendered
      && popoutObservation.privilegedBridgeAbsent
      && popoutObservation.themeMatchesMain
      && popoutObservation.liveThemeSyncWorks
      && popoutObservation.returnedToMainWindow
      && popoutObservation.untrustedWindowDenied
      && settingsTomlCreated
      && consoleErrors.length === 0;
    await writeFile(join(outputRoot, 'electron-runtime-smoke.json'), JSON.stringify({
      passed,
      observation,
      liveTraceObservation,
      popoutObservation,
      settingsTomlCreated,
      consoleErrors,
      screenshot: 'electron-runtime-smoke.png',
      completedAt: new Date().toISOString()
    }, null, 2));
    return passed;
  } finally {
    window.webContents.removeListener('console-message', onConsoleMessage);
  }
}

async function verifyLiveTracePanel(window: BrowserWindow): Promise<LiveTraceObservation> {
  return window.webContents.executeJavaScript(`(async () => {
    const runtime = window.ariadne?.runtime;
    const logsTab = document.querySelector('.module-tab[data-module-id="logs"]');
    if (logsTab instanceof HTMLElement) logsTab.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (
      typeof runtime?.request !== 'function'
      || typeof runtime?.onEvent !== 'function'
    ) {
      return {
        eventReceived: false,
        panelRendered: false,
        category: null,
        message: null,
        level: null,
        metadataVisible: false,
        errorPanelRendered: false,
        errorMessage: null,
        errorMetadataVisible: false
      };
    }

    let removeListener = () => {};
    const liveEntry = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        removeListener();
        resolve(null);
      }, 8_000);
      removeListener = runtime.onEvent((envelope) => {
        const event = envelope?.event;
        if (event?.kind !== 'trace.appended' || event.entry?.category !== 'companion.turn.input') return;
        clearTimeout(timeout);
        removeListener();
        resolve(event.entry);
      });
    });

    let accepted = null;
    try {
      accepted = await runtime.request({
        kind: 'companion.chat.start',
        clientMessageId: 'electron-smoke-live-trace-' + crypto.randomUUID(),
        workspaceId: 'primary',
        message: 'Electron smoke live Trace delivery check',
        routingStrategy: 'privacy-first',
        resources: []
      });
    } catch {}
    const entry = await liveEntry;
    if (accepted?.kind === 'companion.chat.accepted') {
      try {
        await runtime.request({ kind: 'companion.chat.cancel', runId: accepted.runId });
      } catch {}
    }

    const deadline = Date.now() + 5_000;
    let row = null;
    let errorRow = null;
    while (Date.now() < deadline) {
      row = [...document.querySelectorAll('.logs-panel .log-row')].find((candidate) =>
        candidate.querySelector('code')?.textContent?.trim() === 'companion.turn.input'
      ) ?? null;
      errorRow = [...document.querySelectorAll('.logs-panel .log-row.is-error')].find((candidate) =>
        candidate.querySelector('code')?.textContent?.trim() === 'companion.turn.error'
      ) ?? null;
      if (row && errorRow) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const message = row?.querySelector('.log-copy > p')?.textContent?.trim() ?? null;
    const details = row?.querySelector('.log-copy details');
    const errorMessage = errorRow?.querySelector('.log-copy > p')?.textContent?.trim() ?? null;
    const errorDetails = errorRow?.querySelector('.log-copy details');
    return {
      eventReceived: Boolean(entry),
      panelRendered: Boolean(row && message),
      category: entry?.category ?? null,
      message,
      level: entry?.level ?? null,
      metadataVisible: details instanceof HTMLDetailsElement
        && details.textContent?.includes('inputPreview') === true,
      errorPanelRendered: Boolean(errorRow && errorMessage),
      errorMessage,
      errorMetadataVisible: errorDetails instanceof HTMLDetailsElement
        && errorDetails.textContent?.includes('errorCode') === true
    };
  })()`, true) as Promise<LiveTraceObservation>;
}

async function verifyDockviewPopout(mainWindow: BrowserWindow): Promise<PopoutObservation> {
  const untrustedWindowDenied = await mainWindow.webContents.executeJavaScript(
    `window.open('https://example.com', '_blank') === null`,
    true
  ) as boolean;
  const dispatched = await mainWindow.webContents.executeJavaScript(`(() => {
    const moduleTab = document.querySelector('.module-tab[data-module-id="chat.main"]');
    const dockviewTab = moduleTab?.closest('.dv-tab');
    if (!(dockviewTab instanceof HTMLElement)) return false;
    const dragEnd = new DragEvent('dragend', { bubbles: true });
    Object.defineProperties(dragEnd, {
      screenX: { value: window.screenX + window.outerWidth + 80 },
      screenY: { value: window.screenY + Math.max(20, Math.round(window.outerHeight / 2)) }
    });
    dockviewTab.dispatchEvent(dragEnd);
    return true;
  })()`, true) as boolean;
  if (!dispatched) {
    return {
      created: false,
      rendered: false,
      privilegedBridgeAbsent: false,
      themeMatchesMain: false,
      liveThemeSyncWorks: false,
      returnedToMainWindow: false,
      untrustedWindowDenied
    };
  }

  const child = await waitForValue(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && !candidate.isDestroyed()) ?? null,
    5_000
  );
  if (!child) {
    return {
      created: false,
      rendered: false,
      privilegedBridgeAbsent: false,
      themeMatchesMain: false,
      liveThemeSyncWorks: false,
      returnedToMainWindow: false,
      untrustedWindowDenied
    };
  }

  if (child.webContents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      child.webContents.once('did-finish-load', () => resolve());
      child.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`Popout load failed (${code}): ${description}`));
      });
    });
  }
  const rendered = await waitForValue(async () => {
    if (child.isDestroyed()) return false;
    return child.webContents.executeJavaScript(
      `Boolean(document.querySelector('#dv-popout-window .dv-groupview'))`,
      true
    ) as Promise<boolean>;
  }, 5_000) ?? false;
  const privilegedBridgeAbsent = await child.webContents.executeJavaScript(
    `typeof window.ariadne === 'undefined'`,
    true
  ) as boolean;

  const themesMatch = async (): Promise<boolean> => {
    const [mainTheme, childTheme] = await Promise.all([
      mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme ?? null', true) as Promise<string | null>,
      child.webContents.executeJavaScript('document.documentElement.dataset.theme ?? null', true) as Promise<string | null>
    ]);
    return mainTheme !== null && mainTheme === childTheme;
  };
  const themeMatchesMain = await waitForValue(themesMatch, 5_000) ?? false;
  const selectedDarkTheme = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.theme-options button')]
      .find((candidate) => candidate.textContent?.trim() === '深色');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, true) as boolean;
  const bothDark = selectedDarkTheme && (await waitForValue(async () => {
    const [mainTheme, childTheme] = await Promise.all([
      mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme', true) as Promise<string>,
      child.webContents.executeJavaScript('document.documentElement.dataset.theme', true) as Promise<string>
    ]);
    return mainTheme === 'dark' && childTheme === 'dark';
  }, 5_000) ?? false);
  const restoredSystemTheme = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.theme-options button')]
      .find((candidate) => candidate.textContent?.trim() === '跟随系统');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, true) as boolean;
  const liveThemeSyncWorks = bothDark
    && restoredSystemTheme
    && (await waitForValue(themesMatch, 5_000) ?? false);

  await delay(250);
  child.close();
  const returnedToMainWindow = await waitForValue(async () => {
    const childClosed = BrowserWindow.getAllWindows().every((candidate) => candidate === mainWindow || candidate.isDestroyed());
    if (!childClosed) return false;
    return mainWindow.webContents.executeJavaScript(
      `document.querySelector('.module-tab[data-module-id="chat.main"]') !== null`,
      true
    ) as Promise<boolean>;
  }, 5_000) ?? false;

  return {
    created: true,
    rendered,
    privilegedBridgeAbsent,
    themeMatchesMain,
    liveThemeSyncWorks,
    returnedToMainWindow,
    untrustedWindowDenied
  };
}

async function waitForValue<T>(read: () => T | Promise<T>, timeout: number): Promise<T | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  return null;
}

async function waitForRendererReady(window: BrowserWindow): Promise<SmokeObservation> {
  const deadline = Date.now() + 20_000;
  let latest: SmokeObservation | null = null;
  while (Date.now() < deadline) {
    latest = await window.webContents.executeJavaScript(`(async () => {
      const root = document.querySelector('#root');
      const bounds = root?.getBoundingClientRect();
      const runtimeBridge = typeof window.ariadne?.runtime?.getStatus === 'function'
        && typeof window.ariadne?.runtime?.request === 'function';
      const agentSettingsBridge = typeof window.ariadne?.agentSettings?.load === 'function'
        && typeof window.ariadne?.agentSettings?.update === 'function';
      const status = runtimeBridge ? await window.ariadne.runtime.getStatus() : null;
      const agentSettings = agentSettingsBridge ? await window.ariadne.agentSettings.load() : null;
      const primaryWorkspaceId = agentSettings?.workspaces
        ?.find((workspace) => workspace.workspaceId === 'primary')?.workspaceId;
      let workspaceFileContextBound = false;
      let workspaceFileAuthorizationEnforced = false;
      let terminalWorkspaceContextBound = false;
      let terminalWorkspaceAuthorizationEnforced = false;
      if (primaryWorkspaceId && typeof window.ariadne?.workspace?.listDirectory === 'function') {
        try {
          const listing = await window.ariadne.workspace.listDirectory({
            workspaceId: primaryWorkspaceId,
            relativePath: ''
          });
          workspaceFileContextBound = listing.workspaceId === primaryWorkspaceId;
        } catch {}
        try {
          await window.ariadne.workspace.listDirectory({ workspaceId: 'workspace-not-authorized', relativePath: '' });
        } catch {
          workspaceFileAuthorizationEnforced = true;
        }
      }
      if (primaryWorkspaceId && typeof window.ariadne?.terminal?.create === 'function') {
        const terminalSessionId = crypto.randomUUID();
        try {
          const terminal = await window.ariadne.terminal.create({
            sessionId: terminalSessionId,
            workspaceId: primaryWorkspaceId,
            shell: 'cmd',
            columns: 80,
            rows: 24
          });
          terminalWorkspaceContextBound = terminal.workspaceId === primaryWorkspaceId;
        } catch {}
        finally {
          window.ariadne.terminal.close({ sessionId: terminalSessionId });
        }
        const unauthorizedTerminalSessionId = crypto.randomUUID();
        try {
          await window.ariadne.terminal.create({
            sessionId: unauthorizedTerminalSessionId,
            workspaceId: 'workspace-not-authorized',
            shell: 'cmd',
            columns: 80,
            rows: 24
          });
        } catch {
          terminalWorkspaceAuthorizationEnforced = true;
        } finally {
          window.ariadne.terminal.close({ sessionId: unauthorizedTerminalSessionId });
        }
      }
      const runtimeUiReady = document.querySelector('.runtime-title-status')?.classList.contains('runtime-title-status--ready') ?? false;
      const chatPanel = document.querySelector('.chat-panel');
      const chatSidebar = document.querySelector('.chat-conversations-sidebar');
      const chatConversation = document.querySelector('.chat-conversation');
      const chatPanelBounds = chatPanel?.getBoundingClientRect();
      const chatSidebarBounds = chatSidebar?.getBoundingClientRect();
      const chatConversationBounds = chatConversation?.getBoundingClientRect();
      const chatComposed = Boolean(chatPanelBounds && chatSidebarBounds && chatConversationBounds
        && chatSidebarBounds.left >= chatPanelBounds.left - 1
        && chatSidebarBounds.right <= chatConversationBounds.left + 1
        && chatConversationBounds.right <= chatPanelBounds.right + 1);
      const chatConversationStyle = chatConversation instanceof HTMLElement
        ? getComputedStyle(chatConversation)
        : null;
      const chatConversationRounded = Boolean(chatConversationStyle
        && Number.parseFloat(chatConversationStyle.borderTopLeftRadius) >= 8
        && Number.parseFloat(chatConversationStyle.borderBottomLeftRadius) >= 8
        && Number.parseFloat(chatConversationStyle.borderTopWidth) > 0
        && Number.parseFloat(chatConversationStyle.borderBottomWidth) > 0
        && Number.parseFloat(chatConversationStyle.borderLeftWidth) > 0
        && chatConversationStyle.borderRightWidth === '0px'
        && chatConversationStyle.overflow === 'hidden');
      const chatConversationBoundaryMetrics = chatConversationStyle ? {
        borderTopLeftRadius: chatConversationStyle.borderTopLeftRadius,
        borderBottomLeftRadius: chatConversationStyle.borderBottomLeftRadius,
        borderTopWidth: chatConversationStyle.borderTopWidth,
        borderBottomWidth: chatConversationStyle.borderBottomWidth,
        borderLeftWidth: chatConversationStyle.borderLeftWidth,
        borderRightWidth: chatConversationStyle.borderRightWidth,
        overflow: chatConversationStyle.overflow
      } : null;
      let chatMessageTextFidelity = false;
      let chatMessageTextMetrics = null;
      let chatReplyRightBounded = false;
      let chatReplyBoundaryMetrics = null;
      const existingMessageList = document.querySelector('.message-list');
      const temporaryMessageList = existingMessageList instanceof HTMLElement
        ? null
        : document.createElement('div');
      if (temporaryMessageList) {
        temporaryMessageList.className = 'message-list';
        document.querySelector('.message-stage')?.append(temporaryMessageList);
      }
      const messageList = existingMessageList ?? temporaryMessageList;
      if (messageList instanceof HTMLElement) {
        const probe = document.createElement('div');
        probe.className = 'user-message';
        const content = document.createElement('p');
        content.className = 'message-content';
        const exactText = '  你好\\n下一行  ';
        content.textContent = exactText;
        probe.append(content);
        messageList.append(probe);
        const style = getComputedStyle(content);
        const exactTextPreserved = content.textContent === exactText;
        const multilineHeight = content.getBoundingClientRect().height;
        content.textContent = '你好';
        const singleLineHeight = content.getBoundingClientRect().height;
        const expectedLineBox = Number.parseFloat(style.lineHeight)
          + Number.parseFloat(style.paddingTop)
          + Number.parseFloat(style.paddingBottom)
          + Number.parseFloat(style.borderTopWidth)
          + Number.parseFloat(style.borderBottomWidth);
        chatMessageTextMetrics = {
          exactTextPreserved,
          whiteSpace: style.whiteSpace,
          singleLineWidth: content.getBoundingClientRect().width,
          singleLineHeight,
          multilineHeight,
          expectedLineBox
        };
        chatMessageTextFidelity = exactTextPreserved
          && content.textContent === '你好'
          && style.whiteSpace === 'break-spaces'
          && singleLineHeight <= expectedLineBox + 1
          && multilineHeight > singleLineHeight;
        probe.remove();

        const userNode = document.createElement('div');
        userNode.className = 'conversation-node conversation-node--user';
        const userBlock = document.createElement('div');
        userBlock.className = 'user-message-block';
        const userMessage = document.createElement('div');
        userMessage.className = 'user-message';
        const userContent = document.createElement('p');
        userContent.className = 'message-content';
        userContent.textContent = '请生成一个包含长代码块和表格的完整实现方案，用于验证消息右边界。';
        userMessage.append(userContent);
        userBlock.append(userMessage);
        userNode.append(userBlock);

        const assistantNode = document.createElement('div');
        assistantNode.className = 'conversation-node conversation-node--assistant';
        const assistantBlock = document.createElement('div');
        assistantBlock.className = 'assistant-message-block';
        const assistantMessage = document.createElement('div');
        assistantMessage.className = 'assistant-message';
        const markdown = document.createElement('div');
        markdown.className = 'message-content markdown-content';
        const paragraph = document.createElement('p');
        paragraph.textContent = '这是用于验证回复内容边界的说明。';
        const codeBlock = document.createElement('pre');
        codeBlock.textContent = 'const value = "' + 'long-content-'.repeat(80) + '";';
        markdown.append(paragraph, codeBlock);
        assistantMessage.append(markdown);
        assistantBlock.append(assistantMessage);
        assistantNode.append(assistantBlock);
        messageList.append(userNode, assistantNode);

        const userBounds = userContent.getBoundingClientRect();
        const assistantBounds = assistantMessage.getBoundingClientRect();
        const markdownBounds = markdown.getBoundingClientRect();
        const codeBlockBounds = codeBlock.getBoundingClientRect();
        const assistantStyle = getComputedStyle(assistantBlock);
        const codeBlockStyle = getComputedStyle(codeBlock);
        chatReplyBoundaryMetrics = {
          userMessageRight: userBounds.right,
          assistantMessageRight: assistantBounds.right,
          markdownRight: markdownBounds.right,
          codeBlockRight: codeBlockBounds.right,
          assistantOverflowX: assistantStyle.overflowX,
          codeBlockOverflowX: codeBlockStyle.overflowX
        };
        chatReplyRightBounded = assistantBounds.right <= userBounds.right + .5
          && markdownBounds.right <= userBounds.right + .5
          && codeBlockBounds.right <= userBounds.right + .5
          && assistantStyle.overflowX === 'clip'
          && (codeBlockStyle.overflowX === 'auto' || codeBlockStyle.overflowX === 'scroll');
        userNode.remove();
        assistantNode.remove();
        temporaryMessageList?.remove();
      }
      const composer = document.querySelector('.composer textarea');
      const composerFrame = document.querySelector('.composer');
      const composerToolbar = document.querySelector('.composer-toolbar');
      const modelControl = document.querySelector('.composer-model-menu .select-menu-trigger');
      const routingControl = document.querySelector('.composer-routing-menu .select-menu-trigger');
      const permissionModeControl = document.querySelector('.composer-permission-mode-menu .select-menu-trigger');
      const sendButton = document.querySelector('.composer-action-controls .send-button');
      const composerFrameBounds = composerFrame?.getBoundingClientRect();
      const permissionModeBounds = permissionModeControl?.getBoundingClientRect();
      const sendButtonBounds = sendButton?.getBoundingClientRect();
      const composerControlsVisible = composerToolbar instanceof HTMLElement
        && modelControl instanceof HTMLButtonElement
        && routingControl === null
        && permissionModeControl instanceof HTMLButtonElement
        && sendButton instanceof HTMLButtonElement;
      let composerRoutingNested = routingControl === null;
      const composerPermissionModeRightAligned = Boolean(composerFrameBounds && permissionModeBounds && sendButtonBounds
        && permissionModeBounds.left >= composerFrameBounds.left + composerFrameBounds.width * .5
        && permissionModeBounds.right <= sendButtonBounds.left + 1
        && sendButtonBounds.right <= composerFrameBounds.right + 1);
      const composerEnabled = composer instanceof HTMLTextAreaElement && !composer.disabled;
      const catalog = status?.availability === 'ready'
        ? await window.ariadne.runtime.request({ kind: 'models.list' })
        : null;
      const readyModelCount = catalog?.kind === 'models.catalog'
        ? catalog.models.filter((model) => model.availability === 'ready').length
        : 0;
      const composerGuarded = readyModelCount > 0
        ? composerEnabled
        : composer instanceof HTMLTextAreaElement
          && composer.disabled
          && composer.placeholder.includes('设置');
      let selectMenuViewportFit = false;
      let selectMenuCompact = false;
      const selectMenuMetrics = {
        triggerFound: false,
        popoverFound: false,
        parentIsBody: false,
        visibility: '',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        optionHeights: []
      };
      if (modelControl instanceof HTMLButtonElement) {
        selectMenuMetrics.triggerFound = true;
        modelControl.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const popover = document.querySelector('body > .select-menu-popover');
        if (popover instanceof HTMLElement) {
          const automaticModelOption = popover.querySelector('.select-menu-option.is-has-submenu');
          automaticModelOption?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const submenu = document.querySelector('body > .select-menu-submenu');
          const popoverBounds = popover.getBoundingClientRect();
          const submenuBounds = submenu?.getBoundingClientRect();
          const submenuOptions = submenu ? [...submenu.querySelectorAll('.select-menu-option')] : [];
          const optionBounds = [...popover.querySelectorAll('.select-menu-option'), ...submenuOptions]
            .map((option) => option.getBoundingClientRect());
          composerRoutingNested = composerRoutingNested
            && automaticModelOption instanceof HTMLButtonElement
            && automaticModelOption.getAttribute('aria-expanded') === 'true'
            && submenu instanceof HTMLElement
            && submenu.querySelectorAll('.select-menu-option').length === 4;
          Object.assign(selectMenuMetrics, {
            popoverFound: submenu instanceof HTMLElement,
            parentIsBody: popover.parentElement === document.body && submenu?.parentElement === document.body,
            visibility: submenu instanceof HTMLElement ? getComputedStyle(submenu).visibility : '',
            left: Math.min(popoverBounds.left, submenuBounds?.left ?? popoverBounds.left),
            top: Math.min(popoverBounds.top, submenuBounds?.top ?? popoverBounds.top),
            right: Math.max(popoverBounds.right, submenuBounds?.right ?? popoverBounds.right),
            bottom: Math.max(popoverBounds.bottom, submenuBounds?.bottom ?? popoverBounds.bottom),
            optionHeights: optionBounds.map((option) => option.height)
          });
          selectMenuViewportFit = submenuBounds !== undefined
            && [popoverBounds, submenuBounds].every((bounds) => bounds.left >= 7
              && bounds.top >= 7
              && bounds.right <= window.innerWidth - 7
              && bounds.bottom <= window.innerHeight - 7);
          selectMenuCompact = optionBounds.length > 0
            && optionBounds.every((option) => option.height <= 40);
          const routeToSelect = submenu?.querySelectorAll('.select-menu-option')[1];
          if (routeToSelect instanceof HTMLButtonElement) routeToSelect.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const selectionClosed = document.querySelector('body > .select-menu-submenu') === null;
          const automaticLabelPreserved = modelControl.textContent?.includes('自动选择模型') === true;
          modelControl.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const reopenedParent = document.querySelector('body > .select-menu-popover .select-menu-option.is-has-submenu');
          reopenedParent?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const selectedRoute = document.querySelector('body > .select-menu-submenu .select-menu-option[aria-selected="true"]');
          composerRoutingNested = composerRoutingNested
            && selectionClosed
            && automaticLabelPreserved
            && selectedRoute === document.querySelectorAll('body > .select-menu-submenu .select-menu-option')[1];
        }
        modelControl.click();
      }
      const workspaceOpenButton = document.querySelector('.conversation-open-workspace-button');
      const newSessionButton = document.querySelector('.conversation-create-button');
      const workspaceOpenButtonVisible = workspaceOpenButton instanceof HTMLButtonElement
        && workspaceOpenButton.textContent?.includes('打开工作区') === true
        && workspaceOpenButton.getBoundingClientRect().width >= 80
        && workspaceOpenButton.getBoundingClientRect().height >= 28;
      const newSessionButtonVisible = newSessionButton instanceof HTMLButtonElement
        && newSessionButton.textContent?.includes('新建会话') === true
        && newSessionButton.getBoundingClientRect().width >= 80
        && newSessionButton.getBoundingClientRect().height >= 28;
      let sessionCreated = false;
      let sessionCreatedInCurrentWorkspace = false;
      let workspaceConversationTreeReady = false;
      let workspaceCollapseWorks = false;
      let compactConversationRows = false;
      let conversationDetailsPopoverWorks = false;
      let conversationInlineRenameWorks = false;
      let conversationPinWorks = false;
      if (status?.availability === 'ready' && runtimeUiReady) {
        const chatTab = document.querySelector('.module-tab[data-module-id="chat.main"]');
        if (chatTab instanceof HTMLElement) {
          chatTab.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        let listed = await window.ariadne.runtime.request({ kind: 'companion.sessions.list' });
        const existingIds = listed?.kind === 'companion.sessions'
          ? new Set(listed.sessions.map((session) => session.sessionId))
          : new Set();
        const displayedRowBeforeCreate = document.querySelector('.conversation-row.is-active');
        const displayedSessionIdBeforeCreate = displayedRowBeforeCreate instanceof HTMLElement
          ? displayedRowBeforeCreate.dataset.sessionId
          : undefined;
        const selectedWorkspaceBeforeCreate = document.querySelector('.conversation-workspace-header.is-selected');
        const expectedWorkspaceId = listed?.kind === 'companion.sessions'
          ? listed.sessions.find((session) => session.sessionId === displayedSessionIdBeforeCreate)?.workspaceId
            ?? (selectedWorkspaceBeforeCreate instanceof HTMLElement
              ? selectedWorkspaceBeforeCreate.dataset.workspaceId
              : undefined)
          : undefined;
        if (newSessionButton instanceof HTMLButtonElement && !newSessionButton.disabled) {
          newSessionButton.click();
          for (let attempt = 0; attempt < 50; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            listed = await window.ariadne.runtime.request({ kind: 'companion.sessions.list' });
            if (listed?.kind === 'companion.sessions'
              && listed.sessions.some((session) => !existingIds.has(session.sessionId))) break;
          }
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const workspaceHeader = document.querySelector('.conversation-workspace-header');
        let conversationRow = document.querySelector('.conversation-row');
        const createdSession = listed?.kind === 'companion.sessions'
          ? listed.sessions.find((session) => !existingIds.has(session.sessionId))
          : undefined;
        sessionCreated = Boolean(createdSession);
        const activeConversationRow = document.querySelector('.conversation-row.is-active');
        const activeSessionId = activeConversationRow instanceof HTMLElement
          ? activeConversationRow.dataset.sessionId
          : undefined;
        sessionCreatedInCurrentWorkspace = Boolean(
          createdSession
          && expectedWorkspaceId
          && createdSession.sessionId === activeSessionId
          && createdSession.workspaceId === expectedWorkspaceId
        );
        workspaceConversationTreeReady = workspaceHeader instanceof HTMLButtonElement
          && conversationRow instanceof HTMLElement
          && document.querySelector('.workspace-conversation-list') instanceof HTMLElement
          && document.querySelector('.conversation-meta') === null;
        if (workspaceHeader instanceof HTMLButtonElement && conversationRow instanceof HTMLElement) {
          workspaceHeader.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const collapsed = workspaceHeader.getAttribute('aria-expanded') === 'false'
            && document.querySelector('.workspace-conversation-list') === null
            && document.querySelector('.conversation-row') === null;
          workspaceHeader.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          workspaceCollapseWorks = collapsed
            && workspaceHeader.getAttribute('aria-expanded') === 'true'
            && document.querySelector('.workspace-conversation-list') instanceof HTMLElement
            && document.querySelector('.conversation-row') instanceof HTMLElement;
          conversationRow = document.querySelector('.conversation-row');
        }
        compactConversationRows = conversationRow instanceof HTMLElement
          && conversationRow.getBoundingClientRect().height <= 34;

        if (conversationRow instanceof HTMLElement) {
          conversationRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          conversationDetailsPopoverWorks = document.querySelector('.conversation-details-popover[role="tooltip"]') instanceof HTMLElement;
          conversationRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));

          const pinButton = conversationRow.querySelector('.conversation-row-actions button[aria-pressed]');
          if (pinButton instanceof HTMLButtonElement) {
            pinButton.click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const pinnedRow = document.querySelector('.conversation-row.is-pinned');
            conversationPinWorks = pinnedRow instanceof HTMLElement
              && pinnedRow.querySelector('.conversation-pinned-marker') !== null;
          }

          conversationRow = document.querySelector('.conversation-row');
          const rowMain = conversationRow.querySelector('.conversation-row-main');
          if (rowMain instanceof HTMLElement) {
            rowMain.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const renameInput = document.querySelector('.conversation-title-input');
            conversationInlineRenameWorks = renameInput instanceof HTMLInputElement;
            if (renameInput instanceof HTMLInputElement) {
              renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              renameInput.blur();
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
          }
        }
      }
      let logsLayoutNoOverlap = false;
      let logsLayoutMetrics = null;
      const logsProbe = document.createElement('section');
      logsProbe.className = 'logs-panel';
      logsProbe.style.cssText = 'position:fixed;left:0;top:0;width:520px;height:80px;visibility:hidden;';
      const logRow = document.createElement('div');
      logRow.className = 'log-row is-error';
      const logTime = document.createElement('span');
      logTime.textContent = '21:59:11';
      const logIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      logIcon.setAttribute('width', '13');
      logIcon.setAttribute('height', '13');
      const logCategory = document.createElement('code');
      logCategory.textContent = 'assistant_agent_proposal_settled_with_extended_diagnostics';
      const logMessage = document.createElement('p');
      logMessage.textContent = '提案执行失败。';
      logRow.append(logTime, logIcon, logCategory, logMessage);
      logsProbe.append(logRow);
      document.body.append(logsProbe);
      const categoryBounds = logCategory.getBoundingClientRect();
      const messageBounds = logMessage.getBoundingClientRect();
      const categoryStyle = getComputedStyle(logCategory);
      const logGap = messageBounds.left - categoryBounds.right;
      logsLayoutMetrics = {
        categoryRight: categoryBounds.right,
        messageLeft: messageBounds.left,
        gap: logGap,
        categoryOverflow: categoryStyle.overflow,
        categoryTextOverflow: categoryStyle.textOverflow
      };
      logsLayoutNoOverlap = logGap >= 7
        && categoryStyle.overflow === 'hidden'
        && categoryStyle.textOverflow === 'ellipsis';
      logsProbe.remove();
      document.querySelector('button[aria-label="设置"]')?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const providerCards = [...document.querySelectorAll('.provider-settings-card')];
      const providerCardCount = providerCards.length;
      const collapsedProviderCardCount = providerCards.filter((card) => {
        const disclosure = card.querySelector('.provider-disclosure');
        const body = card.querySelector('.provider-settings-body');
        return disclosure?.getAttribute('aria-expanded') === 'false'
          && body instanceof HTMLElement
          && body.hidden;
      }).length;
      let providerDisclosureWorks = false;
      const firstDisclosure = providerCards[0]?.querySelector('.provider-disclosure');
      const firstBody = providerCards[0]?.querySelector('.provider-settings-body');
      if (firstDisclosure instanceof HTMLButtonElement && firstBody instanceof HTMLElement) {
        firstDisclosure.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        providerDisclosureWorks = firstDisclosure.getAttribute('aria-expanded') === 'true' && !firstBody.hidden;
        firstDisclosure.click();
      }
      let narrowSettingsLayoutFits = false;
      const settingsPanel = document.querySelector('.settings-panel');
      if (settingsPanel instanceof HTMLElement) {
        const previousWidth = settingsPanel.style.width;
        settingsPanel.style.width = '340px';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        narrowSettingsLayoutFits = settingsPanel.scrollWidth <= settingsPanel.clientWidth + 1;
        settingsPanel.style.width = previousWidth;
      }
      const settingsUiReady = document.body.textContent?.includes('Agent 与模型') === true
        && document.querySelectorAll('.provider-settings-card input[type="password"]').length === 4;
      const settingsFieldLabels = [...document.querySelectorAll('.settings-panel .settings-field > span')]
        .map((label) => label.textContent?.trim());
      const settingsNoDynamicRuntimeControls = !settingsFieldLabels.includes('工作区访问')
        && !settingsFieldLabels.includes('路由策略');
      return {
        documentTitle: document.title,
        rootWidth: Math.round(bounds?.width ?? 0),
        rootHeight: Math.round(bounds?.height ?? 0),
        runtimeStatus: status?.availability ?? 'missing',
        runtimeDetail: status?.detail ?? null,
        runtimeBridge,
        agentSettingsBridge,
        runtimeUiReady,
        chatComposed,
        chatConversationRounded,
        chatConversationBoundaryMetrics,
        chatMessageTextFidelity,
        chatMessageTextMetrics,
        chatReplyRightBounded,
        chatReplyBoundaryMetrics,
        composerEnabled,
        composerGuarded,
        composerControlsVisible,
        composerRoutingNested,
        composerPermissionModeRightAligned,
        readyModelCount,
        selectMenuViewportFit,
        selectMenuCompact,
        selectMenuMetrics,
        workspaceOpenButtonVisible,
        newSessionButtonVisible,
        workspaceFileContextBound,
        workspaceFileAuthorizationEnforced,
        terminalWorkspaceContextBound,
        terminalWorkspaceAuthorizationEnforced,
        sessionCreated,
        sessionCreatedInCurrentWorkspace,
        workspaceConversationTreeReady,
        workspaceCollapseWorks,
        compactConversationRows,
        conversationDetailsPopoverWorks,
        conversationInlineRenameWorks,
        conversationPinWorks,
        settingsUiReady,
        settingsNoDynamicRuntimeControls,
        providerCardCount,
        collapsedProviderCardCount,
        providerDisclosureWorks,
        narrowSettingsLayoutFits,
        logsLayoutNoOverlap,
        logsLayoutMetrics
      };
    })()`, true) as SmokeObservation;
    if (latest.runtimeStatus === 'ready'
      && latest.runtimeUiReady
      && latest.chatComposed
      && latest.chatConversationRounded
      && latest.chatMessageTextFidelity
      && latest.chatReplyRightBounded
      && latest.composerGuarded
      && latest.composerControlsVisible
      && latest.composerRoutingNested
      && latest.composerPermissionModeRightAligned
      && latest.selectMenuViewportFit
      && latest.selectMenuCompact
      && latest.workspaceOpenButtonVisible
      && latest.newSessionButtonVisible
      && latest.workspaceFileContextBound
      && latest.workspaceFileAuthorizationEnforced
      && latest.terminalWorkspaceContextBound
      && latest.terminalWorkspaceAuthorizationEnforced
      && latest.sessionCreated
      && latest.sessionCreatedInCurrentWorkspace
      && latest.workspaceConversationTreeReady
      && latest.workspaceCollapseWorks
      && latest.compactConversationRows
      && latest.conversationDetailsPopoverWorks
      && latest.conversationInlineRenameWorks
      && latest.conversationPinWorks
      && latest.settingsUiReady
      && latest.settingsNoDynamicRuntimeControls
      && latest.logsLayoutNoOverlap) return latest;
    if (latest.runtimeStatus === 'disabled') return latest;
    await delay(100);
  }
  if (latest) return latest;
  throw new Error('Renderer smoke test did not produce an observation.');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
