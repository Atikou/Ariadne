import { app, BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

interface SmokeResult {
  passed: boolean;
  runtimeReady: boolean;
  projectionReady: boolean;
  projectedModelCount: number;
  configuredAgentModelExclusive: boolean;
  configuredModelMislabelAbsent: boolean;
  newDraftDidNotCreateSession: boolean;
  composerWorkspaceSelectorVisible: boolean;
  runtimeStatusConsistent: boolean;
  conversationContextMenuVisible: boolean;
  conversationRenameProjected: boolean;
  conversationArchiveProjected: boolean;
  conversationRestoreProjected: boolean;
  sessionCreated: boolean;
  messageAccepted: boolean;
  sessionProjected: boolean;
  messageProjected: boolean;
  directStreamObserved: boolean;
  directStreamChunkCount: number;
  directAgentCompleted: boolean;
  imageAttachmentCompleted: boolean;
  imageAttachmentVisible: boolean;
  inboxContinuationCompleted: boolean;
  agentInputDeliveryRecovered: boolean;
  rendererReloadDeliveryRecovered: boolean;
  userQuestionCompleted: boolean;
  userQuestionRuntimeRecoveryCompleted: boolean;
  readToolCompleted: boolean;
  permissionBlockedBeforeAllow: boolean;
  permissionAllowCompleted: boolean;
  permissionDenyPreventedEffect: boolean;
  cancelCompleted: boolean;
  inferenceCrashRecovered: boolean;
  effectCrashRecoveredWithoutReplay: boolean;
  projectionCrashReplayedWithoutDuplicateEffect: boolean;
  runtimeBoundaryKillsAcknowledged: boolean;
  providerTraceValid: boolean;
  providerRequests: number;
  providerResponses: number;
  providerAborted: number;
  fatalError: string | null;
  consoleErrors: string[];
  screenshot: string;
  completedAt: string;
}

interface SmokeObservation {
  fatalError?: string;
  runtimeReady?: boolean;
  projectionReady?: boolean;
  projectedModelCount?: number;
  configuredAgentModelExclusive?: boolean;
  configuredModelMislabelAbsent?: boolean;
  newDraftDidNotCreateSession?: boolean;
  composerWorkspaceSelectorVisible?: boolean;
  runtimeStatusConsistent?: boolean;
  conversationContextMenuVisible?: boolean;
  conversationRenameProjected?: boolean;
  conversationArchiveProjected?: boolean;
  conversationRestoreProjected?: boolean;
  sessionCreated?: boolean;
  messageAccepted?: boolean;
  sessionProjected?: boolean;
  messageProjected?: boolean;
  directStreamObserved?: boolean;
  directStreamChunkCount?: number;
  directAgentCompleted?: boolean;
  imageAttachmentCompleted?: boolean;
  imageAttachmentVisible?: boolean;
  inboxContinuationCompleted?: boolean;
  agentInputDeliveryRecovered?: boolean;
  rendererReloadDeliveryRecovered?: boolean;
  deliveryRecoverySessionId?: string;
  deliveryRecoveryRunId?: string;
  userQuestionCompleted?: boolean;
  userQuestionRuntimeRecoveryCompleted?: boolean;
  readToolCompleted?: boolean;
  permissionBlockedBeforeAllow?: boolean;
  permissionAllowCompleted?: boolean;
  permissionDenyPreventedEffect?: boolean;
  cancelCompleted?: boolean;
  inferenceCrashRecovered?: boolean;
  effectCrashRecoveredWithoutReplay?: boolean;
  projectionCrashReplayedWithoutDuplicateEffect?: boolean;
  runtimeBoundaryKillsAcknowledged?: boolean;
}

interface DesktopRestartDeliveryResult {
  passed: boolean;
  commandId: string | null;
  inputId: string | null;
  sessionId: string | null;
  receiptRecovered: boolean;
  retainedBeforeSettlement: boolean;
  absentFromProjection: boolean;
  settled: boolean;
  fatalError: string | null;
  completedAt: string;
}

interface ProviderScenarioState {
  requests: number;
  responses: number;
  aborted: number;
  initialRequests: number;
  continuationRequests: number;
}

interface ProviderState {
  protocol: string;
  requests: number;
  responses: number;
  aborted: number;
  scenarios: Record<string, ProviderScenarioState>;
}

/**
 * Real-window Agent acceptance over the production public path. The model is
 * an external deterministic HTTPS fixture; Main, Runtime, SQLite, Agent
 * Control, permission decisions and first-party Tools are the shipped code.
 */
export async function runElectronSmokeTest(
  window: BrowserWindow,
  outputRoot: string
): Promise<boolean> {
  if (!isAbsolute(outputRoot)) throw new Error('ARIADNE_SMOKE_TEST_OUTPUT must be absolute.');
  const providerBaseUrl = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_BASE_URL');
  const providerModel = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_MODEL');
  const providerStatePath = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_STATE');
  const workspaceId = requireSmokeEnvironment('ARIADNE_SMOKE_WORKSPACE_ID');
  await mkdir(outputRoot, { recursive: true });
  if (window.webContents.isLoading()) await waitForLoad(window);

  window.setSkipTaskbar(true);
  window.setPosition(-10_000, -10_000, false);
  window.showInactive();
  const consoleErrors: string[] = [];
  const onConsoleMessage = (
    _event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    level: number,
    message: string
  ): void => {
    if (level === 3) consoleErrors.push(message.slice(0, 512));
  };
  window.webContents.on('console-message', onConsoleMessage);

  try {
    if (process.env.ARIADNE_SMOKE_DESKTOP_DELIVERY_VERIFY === '1') {
      return await verifyDeliveryDesktopRestart(window, workspaceId, outputRoot);
    }
    const observation = await window.webContents.executeJavaScript(`(async () => {
      try {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let diagnosticSnapshot = null;
        let lifecycleStep = 'not_started';
        const waitUntil = async (probe, timeoutMs = 60_000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const value = await probe();
            if (value) return value;
            await delay(50);
          }
          throw new Error('smoke_wait_timeout:' + JSON.stringify({
            lifecycleStep,
            diagnosticSnapshot
          }));
        };
        const waitUntilAcrossRuntimeRestart = async (probe, timeoutMs = 60_000) => {
          const deadline = Date.now() + timeoutMs;
          let lastError = null;
          while (Date.now() < deadline) {
            try {
              const value = await probe();
              if (value) return value;
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error);
            }
            await delay(100);
          }
          throw new Error('smoke_restart_wait_timeout:' + JSON.stringify({
            lastError,
            diagnosticSnapshot
          }));
        };
        const api = window.ariadne;
        if (!api?.runtime) throw new Error('preload_bridge_missing');
        const request = async (command) => {
          const result = await api.runtime.request(command);
          if (!result.ok) throw new Error('runtime_request_failed:' + JSON.stringify(result));
          return result.value;
        };
        const snapshot = async () => {
          const value = await request({
            kind: 'projection.snapshot.get',
            contractVersion: '3.0'
          });
          if (value.kind !== 'projection.snapshot') throw new Error('projection_snapshot_kind_invalid');
          diagnosticSnapshot = {
            lifecycleStep,
            sessions: value.snapshot.sessions,
            runs: value.snapshot.runs,
            messages: value.snapshot.messages,
            inferenceStreams: value.snapshot.inferenceStreams,
            decisions: value.snapshot.decisions,
            diagnostics: value.snapshot.diagnostics
          };
          return value.snapshot;
        };
        const createRun = async (marker) => {
          const sessionId = crypto.randomUUID();
          const messageId = crypto.randomUUID();
          const created = await request({
            kind: 'conversation.session.create.v3',
            contractVersion: '3.0',
            sessionId,
            workspaceId: ${JSON.stringify(workspaceId)}
          });
          if (created.kind !== 'conversation.session.created.v3') {
            throw new Error('session_create_result_invalid');
          }
          const accepted = await request({
            kind: 'conversation.message.accept.v3',
            contractVersion: '3.0',
            sessionId,
            workspaceId: ${JSON.stringify(workspaceId)},
            expectedSessionVersion: created.version,
            messageId,
            content: marker,
            execution: { mode: 'agent', modelId: ${JSON.stringify(providerModel)} }
          });
          if (accepted.kind !== 'conversation.message.accepted.v3') {
            throw new Error('message_accept_result_invalid');
          }
          const run = await waitUntil(async () => {
            const current = await snapshot();
            return current.runs.find((item) => item.sourceMessageId === messageId) ?? null;
          });
          return { sessionId, messageId, runId: run.runId, created, accepted };
        };
        const waitForRun = async (runId, predicate, timeoutMs = 60_000) => waitUntil(async () => {
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === runId);
          return run && predicate(run, current) ? { run, snapshot: current } : null;
        }, timeoutMs);
        const pendingPermission = async (runId) => waitUntil(async () => {
          const current = await snapshot();
          return current.decisions.find((item) => (
            item.runId === runId
            && item.kind === 'permission'
            && item.status === 'pending'
            && item.action
          )) ?? null;
        });
        const resolvePermission = (runId, decision, choice) => request({
          kind: 'agent.decision.resolve.v3',
          contractVersion: '3.0',
          runId,
          decisionId: decision.decisionId,
          action: {
            contractVersion: decision.action.contractVersion,
            actionToken: decision.action.actionToken,
            choice
          }
        });
        const listWorkspace = (relativePath = '') => api.workspace.listDirectory({
          workspaceId: ${JSON.stringify(workspaceId)},
          relativePath
        });
        const waitForRuntimeKillAck = (name) => waitUntilAcrossRuntimeRestart(async () => {
          const listing = await listWorkspace('runtime-kills');
          return listing.entries.some((entry) => entry.name === name) ? true : null;
        }, 90_000);

        const settings = await api.agentSettings.load();
        const configured = await api.agentSettings.apply({
          expectedRevision: settings.revision,
          operations: [
            {
              kind: 'provider.update',
              providerId: 'openai',
              patch: {
                enabled: true,
                baseUrl: ${JSON.stringify(providerBaseUrl)},
                model: ${JSON.stringify(providerModel)},
                apiKey: 'ariadne-electron-smoke-key'
              }
            },
            { kind: 'provider.update', providerId: 'deepseek', patch: { enabled: false } },
            { kind: 'provider.update', providerId: 'kimi', patch: { enabled: false } },
            { kind: 'provider.update', providerId: 'anthropic', patch: { enabled: false } }
          ]
        });
        if (!configured.ok) throw new Error('settings_apply_failed:' + JSON.stringify(configured));

        const status = await waitUntil(async () => {
          const result = await api.runtime.getStatus();
          return result.ok && result.value.availability === 'ready' ? result.value : null;
        });
        const initialProjection = await waitUntil(async () => {
          const current = await snapshot();
          return current.models.some((item) => (
            item.modelId === ${JSON.stringify(providerModel)}
            && item.availability === 'ready'
            && item.supportsAgent
          )) ? current : null;
        });

        const sessionsBeforeDraft = initialProjection.sessions.map((session) => session.sessionId).sort();
        const workspaceButton = await waitUntil(() => document.querySelector(
          '.conversation-workspace-row[data-workspace-id="' + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main'
        ));
        workspaceButton.click();
        await waitUntil(() => document.querySelector('.composer-workspace-menu .select-menu-trigger'));
        document.querySelector('.conversation-create-button')?.click();
        await delay(150);
        const sessionsAfterDraft = (await snapshot()).sessions.map((session) => session.sessionId).sort();
        const newDraftDidNotCreateSession = JSON.stringify(sessionsBeforeDraft)
          === JSON.stringify(sessionsAfterDraft);
        const composerWorkspaceSelectorVisible = Boolean(
          document.querySelector('.composer-workspace-menu .select-menu-trigger')
        );

        const composer = document.querySelector('.composer textarea');
        if (!(composer instanceof HTMLTextAreaElement)) throw new Error('composer_missing');
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        setValue?.call(composer, 'ariadne-smoke:direct');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const enabledSendButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        enabledSendButton.click();
        const directStreamObserved = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.role === 'user' && item.content === 'ariadne-smoke:direct'
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          const stream = run
            ? current.inferenceStreams.find((item) => (
                item.runId === run.runId
                && item.status === 'streaming'
                && item.chunks.length >= 1
              ))
            : undefined;
          return stream ? { run, stream } : null;
        });
        const direct = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.role === 'user' && item.content === 'ariadne-smoke:direct'
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          const assistant = run
            ? current.messages.find((item) => (
                item.runId === run.runId
                && item.role === 'assistant'
                && item.status === 'completed'
                && item.content === 'ARIADNE_SMOKE_DIRECT_OK'
              ))
            : undefined;
          return userMessage && run?.status === 'completed' && assistant
            ? { current, userMessage, run, assistant }
            : null;
        });

        const imageInput = document.querySelector('.composer-image-file-input');
        if (!(imageInput instanceof HTMLInputElement)) throw new Error('image_input_missing');
        const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        const pngBytes = Uint8Array.from(atob(pngBase64), (value) => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([pngBytes], 'smoke.png', { type: 'image/png' }));
        Object.defineProperty(imageInput, 'files', { configurable: true, value: transfer.files });
        imageInput.dispatchEvent(new Event('change', { bubbles: true }));
        await waitUntil(() => document.querySelector('.composer-image-draft'));
        setValue?.call(composer, 'ariadne-smoke:image');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const imageSendButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        imageSendButton.click();
        const image = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.role === 'user'
            && item.content === 'ariadne-smoke:image'
            && item.attachments?.length === 1
            && item.attachments[0]?.mediaType === 'image/webp'
            && item.attachments[0]?.name === 'smoke.png'
            && item.attachments[0]?.width === 1
            && item.attachments[0]?.height === 1
            && item.attachments[0]?.attachmentId.startsWith('sha256:')
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          const assistant = run
            ? current.messages.find((item) => (
                item.runId === run.runId
                && item.role === 'assistant'
                && item.status === 'completed'
                && item.content === 'ARIADNE_SMOKE_IMAGE_OK'
              ))
            : undefined;
          return userMessage && run?.status === 'completed' && assistant
            ? { userMessage, run, assistant }
            : null;
        });
        const imageAttachmentVisible = Boolean(await waitUntil(() => {
          return document.querySelector('.message-image-attachment') ? true : null;
        }));

        lifecycleStep = 'expand_workspace';
        const lifecycleWorkspaceButton = document.querySelector(
          '.conversation-workspace-row[data-workspace-id="' + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main'
        );
        if (!(lifecycleWorkspaceButton instanceof HTMLButtonElement)) {
          throw new Error('lifecycle_workspace_button_missing');
        }
        if (lifecycleWorkspaceButton.getAttribute('aria-expanded') !== 'true') {
          lifecycleWorkspaceButton.click();
          await waitUntil(() => document.querySelector(
            '.conversation-workspace-row[data-workspace-id="' + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main'
          )?.getAttribute('aria-expanded') === 'true');
        }
        lifecycleStep = 'open_context_menu';
        const uiSessionRow = await waitUntil(() => (
          document.querySelector('.conversation-row[data-session-id="' + direct.run.sessionId + '"]')
        ));
        uiSessionRow.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 120,
          clientY: 120
        }));
        const contextMenuItems = await waitUntil(() => {
          const menu = document.querySelector('.conversation-context-menu[role="menu"]');
          if (!menu) return null;
          return [...menu.querySelectorAll('[role="menuitem"]')]
            .map((item) => item.textContent?.trim() ?? '');
        });
        const conversationContextMenuVisible = JSON.stringify(contextMenuItems) === JSON.stringify([
          '置顶聊天',
          '重命名聊天',
          '归档聊天',
          '标记为未读'
        ]);
        const clickMenuItem = (label) => {
          const item = [...document.querySelectorAll(
            '.conversation-context-menu [role="menuitem"]'
          )].find((candidate) => candidate.textContent?.trim() === label);
          if (!(item instanceof HTMLButtonElement)) throw new Error('conversation_menu_item_missing:' + label);
          item.click();
        };
        const openSessionMenu = async () => {
          const row = await waitUntil(() => document.querySelector(
            '.conversation-row[data-session-id="' + direct.run.sessionId + '"]'
          ));
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 120,
            clientY: 120
          }));
          await waitUntil(() => document.querySelector('.conversation-context-menu[role="menu"]'));
        };

        lifecycleStep = 'rename_dialog';
        clickMenuItem('重命名聊天');
        const renameDialog = await waitUntil(() => document.querySelector(
          '.action-dialog--prompt[role="dialog"]'
        ));
        const renameInput = renameDialog.querySelector('input');
        if (!(renameInput instanceof HTMLInputElement)) throw new Error('conversation_rename_input_missing');
        const setInputValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set;
        const lifecycleTitle = 'Ariadne Smoke Durable Session';
        setInputValue?.call(renameInput, lifecycleTitle);
        renameInput.dispatchEvent(new Event('input', { bubbles: true }));
        const renameSubmit = await waitUntil(() => {
          const button = [...renameDialog.querySelectorAll('button')].find(
            (candidate) => candidate.textContent?.trim() === '保存'
          );
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        lifecycleStep = 'rename_projecting';
        renameSubmit.click();
        const conversationRenameProjected = Boolean(await waitUntil(async () => {
          const current = await snapshot();
          return current.sessions.some((session) => (
            session.sessionId === direct.run.sessionId
            && session.title === lifecycleTitle
            && session.status === 'active'
          )) ? true : null;
        }));

        lifecycleStep = 'archive_dialog';
        await openSessionMenu();
        clickMenuItem('归档聊天');
        const archiveDialog = await waitUntil(() => document.querySelector(
          '.action-dialog[role="alertdialog"]'
        ));
        const archiveConfirm = [...archiveDialog.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === '归档聊天'
        );
        if (!(archiveConfirm instanceof HTMLButtonElement)) {
          throw new Error('conversation_archive_confirm_missing');
        }
        lifecycleStep = 'archive_projecting';
        archiveConfirm.click();
        const conversationArchiveProjected = Boolean(await waitUntil(async () => {
          const current = await snapshot();
          const session = current.sessions.find((candidate) => (
            candidate.sessionId === direct.run.sessionId
          ));
          return session?.status === 'archived'
            && !document.querySelector(
              '.conversation-row[data-session-id="' + direct.run.sessionId + '"]'
            ) ? true : null;
        }));

        lifecycleStep = 'restore_dialog';
        const settingsButton = document.querySelector('button[aria-label="设置"]');
        if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('settings_button_missing');
        settingsButton.click();
        const settingsDialog = await waitUntil(() => document.querySelector(
          '.settings-dialog[role="dialog"]'
        ));
        const archiveCategory = [...settingsDialog.querySelectorAll(
          '.settings-navigation-item'
        )].find((button) => button.getAttribute('title') === '归档管理');
        if (!(archiveCategory instanceof HTMLButtonElement)) {
          throw new Error('settings_archive_category_missing');
        }
        archiveCategory.click();
        const restoreButton = await waitUntil(() => {
          const cards = [...settingsDialog.querySelectorAll('.archived-workspace-card')];
          const card = cards.find((candidate) => (
            candidate.querySelector('strong')?.textContent?.trim() === lifecycleTitle
          ));
          const button = card?.querySelector('button');
          return button instanceof HTMLButtonElement ? button : null;
        });
        lifecycleStep = 'restore_projecting';
        restoreButton.click();
        const conversationRestoreProjected = Boolean(await waitUntil(async () => {
          const current = await snapshot();
          return current.sessions.some((session) => (
            session.sessionId === direct.run.sessionId
            && session.title === lifecycleTitle
            && session.status === 'active'
          )) ? true : null;
        }));
        lifecycleStep = 'complete';
        const closeSettings = settingsDialog.querySelector('button[aria-label="关闭设置"]');
        if (!(closeSettings instanceof HTMLButtonElement)) throw new Error('settings_close_missing');
        closeSettings.click();
        const restoredSessionButton = await waitUntil(() => document.querySelector(
          '.conversation-row[data-session-id="' + direct.run.sessionId + '"] .conversation-row-main'
        ));
        if (!(restoredSessionButton instanceof HTMLElement)) {
          throw new Error('restored_conversation_row_missing');
        }
        restoredSessionButton.click();
        await waitUntil(() => document.querySelector('.chat-header h1')?.textContent?.trim()
          === lifecycleTitle);
        await waitUntil(() => !document.querySelector('.conversation-context-menu[role="menu"]'));
        const runtimeStatusConsistent = Boolean(await waitUntil(() => {
          const consumers = [...document.querySelectorAll('[data-runtime-availability]')];
          return consumers.length >= 3
            && consumers.every((consumer) => consumer.getAttribute('data-runtime-availability') === 'ready');
        }));

        const read = await createRun('ariadne-smoke:read');
        const readDecision = await pendingPermission(read.runId);
        await resolvePermission(read.runId, readDecision, 'allow_once');
        const readTerminal = await waitForRun(read.runId, (run, current) => (
          run.status === 'completed'
          && run.toolActivities.some((activity) => (
            activity.toolName === 'workspace.read_file' && activity.status === 'completed'
          ))
          && current.messages.some((message) => (
            message.runId === run.runId
            && message.role === 'assistant'
            && message.status === 'completed'
            && message.content === 'ARIADNE_SMOKE_READ_OK'
          ))
        ));

        setValue?.call(composer, 'ariadne-smoke:inbox');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const inboxStartButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        inboxStartButton.click();
        const inbox = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.sessionId === direct.run.sessionId
            && item.role === 'user'
            && item.content === 'ariadne-smoke:inbox'
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          return run?.status === 'running' ? { runId: run.runId, sessionId: run.sessionId } : null;
        });
        setValue?.call(composer, 'ARIADNE_SMOKE_INBOX_INPUT');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const inboxSendButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement
            && !button.disabled
            && button.getAttribute('aria-label') === '排到下一轮'
            ? button
            : null;
        });
        inboxSendButton.click();
        const queuedInbox = await waitForRun(inbox.runId, (run) => run.inbox.some((input) => (
          input.delivery === 'next_turn'
          && input.content === 'ARIADNE_SMOKE_INBOX_INPUT'
          && input.state === 'queued'
        )));
        const inboxInputId = queuedInbox.run.inbox.find((input) => (
          input.content === 'ARIADNE_SMOKE_INBOX_INPUT'
        ))?.inputId;
        if (typeof inboxInputId !== 'string') throw new Error('inbox_input_identity_missing');
        const inboxTerminal = await waitForRun(inbox.runId, (run, current) => (
          run.status === 'completed'
          && run.inbox.some((input) => (
            input.inputId === inboxInputId
            && input.state === 'claimed'
            && typeof input.claimedTurnId === 'string'
          ))
          && run.interactionMessages.some((message) => (
            message.role === 'assistant'
            && message.content === 'ARIADNE_SMOKE_INBOX_FIRST'
          ))
          && run.interactionMessages.some((message) => (
            message.messageId === inboxInputId
            && message.role === 'user'
            && message.content === 'ARIADNE_SMOKE_INBOX_INPUT'
          ))
          && current.messages.some((message) => (
            message.runId === run.runId
            && message.role === 'assistant'
            && message.status === 'completed'
            && message.content === 'ARIADNE_SMOKE_INBOX_FINAL'
          ))
        ));
        const inboxTranscriptVisible = Boolean(await waitUntil(() => {
          const text = document.querySelector('.chat-panel')?.textContent ?? '';
          return text.includes('ARIADNE_SMOKE_INBOX_FIRST')
            && text.includes('ARIADNE_SMOKE_INBOX_INPUT')
            && text.includes('ARIADNE_SMOKE_INBOX_FINAL');
        }));

        lifecycleStep = 'question_delivery_recovery';
        setValue?.call(composer, 'ariadne-smoke:question');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const questionStartButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        questionStartButton.click();
        const questionPending = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.sessionId === direct.run.sessionId
            && item.role === 'user'
            && item.content === 'ariadne-smoke:question'
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          const decision = run
            ? current.decisions.find((item) => (
                item.runId === run.runId
                && item.kind === 'user_question'
                && item.status === 'pending'
                && item.presentation?.kind === 'user_question'
                && item.presentation.question
                  === 'Which execution path should Ariadne use for this smoke?'
                && item.action
              ))
            : undefined;
          return run && decision ? { runId: run.runId, decisionId: decision.decisionId } : null;
        });
        const questionCard = await waitUntil(() => {
          const card = document.querySelector('section[aria-label="Agent 需要你的输入"]');
          return card?.textContent?.includes('Which execution path should Ariadne use for this smoke?')
            ? card
            : null;
        });
        let deliveryReconcileObserved = false;
        let deliveryReconcileClicked = false;
        let deliveryCommandId = null;
        const deliveryObserver = new MutationObserver(() => {
          const row = [...document.querySelectorAll('.agent-input-delivery')].find((candidate) => (
            candidate.textContent?.includes('ARIADNE_SMOKE_DELIVERY_INPUT')
          ));
          if (!(row instanceof HTMLElement) || row.dataset.state !== 'reconcile') return;
          deliveryReconcileObserved = true;
          deliveryCommandId = row.dataset.commandId ?? deliveryCommandId;
          const retry = [...row.querySelectorAll('button')].find((button) => (
            button.textContent?.trim() === '重新确认'
          ));
          if (
            !deliveryReconcileClicked
            && retry instanceof HTMLButtonElement
            && !retry.disabled
          ) {
            deliveryReconcileClicked = true;
            retry.click();
          }
        });
        deliveryObserver.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true
        });
        setValue?.call(composer, 'ARIADNE_SMOKE_DELIVERY_INPUT');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const deliverySendButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement
            && !button.disabled
            && button.getAttribute('aria-label') === '排到下一轮'
            ? button
            : null;
        });
        deliverySendButton.click();
        const deliveryKillAcknowledged = await waitForRuntimeKillAck('inbox-killed.json');
        const recoveredDelivery = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === questionPending.runId);
          const inputs = run?.inbox.filter((input) => (
            input.content === 'ARIADNE_SMOKE_DELIVERY_INPUT'
          )) ?? [];
          const receipt = [...document.querySelectorAll(
            '.agent-input-delivery[data-state="accepted"]'
          )].find((candidate) => (
            candidate.textContent?.includes('ARIADNE_SMOKE_DELIVERY_INPUT')
          ));
          if (!(receipt instanceof HTMLElement) || inputs.length !== 1) return null;
          const commandId = receipt.dataset.commandId;
          return typeof commandId === 'string' && commandId.length > 0
            ? { run, input: inputs[0], receipt, commandId }
            : null;
        }, 90_000);
        deliveryObserver.disconnect();
        deliveryCommandId ??= recoveredDelivery.commandId;
        const closeDeliveryReceipt = [...recoveredDelivery.receipt.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === '关闭');
        if (!(closeDeliveryReceipt instanceof HTMLButtonElement)) {
          throw new Error('agent_input_delivery_close_missing');
        }
        closeDeliveryReceipt.click();
        const deliveryReceiptClosed = Boolean(await waitUntil(() => (
          document.querySelector(
            '.agent-input-delivery[data-command-id="' + deliveryCommandId + '"]'
          ) ? null : true
        )));
        const queuedDeliveryRow = await waitUntil(() => {
          const row = [...document.querySelectorAll('.agent-inbox-row')].find((candidate) => (
            candidate.textContent?.includes('ARIADNE_SMOKE_DELIVERY_INPUT')
          ));
          return row instanceof HTMLElement ? row : null;
        });
        const removeDeliveryInput = [...queuedDeliveryRow.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === '移除');
        if (!(removeDeliveryInput instanceof HTMLButtonElement)) {
          throw new Error('agent_input_delivery_remove_missing');
        }
        removeDeliveryInput.click();
        const deliveryInputRemoved = await waitForRun(questionPending.runId, (run) => (
          !run.inbox.some((input) => input.content === 'ARIADNE_SMOKE_DELIVERY_INPUT')
        ));
        const deliveryRecoveredQuestionCard = await waitUntil(() => {
          const card = document.querySelector('section[aria-label="Agent 需要你的输入"]');
          return card?.textContent?.includes('Which execution path should Ariadne use for this smoke?')
            ? card
            : null;
        });
        const localAnswerButton = [...deliveryRecoveredQuestionCard.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Local only'
        );
        if (!(localAnswerButton instanceof HTMLButtonElement)) {
          throw new Error('user_question_local_answer_missing');
        }
        localAnswerButton.click();
        const questionTerminal = await waitForRun(questionPending.runId, (run, current) => (
          run.status === 'completed'
          && run.inbox.some((input) => (
            input.source?.kind === 'user_question_answer'
            && input.content === 'local: Local only'
            && input.state === 'claimed'
          ))
          && run.interactionMessages.some((message) => (
            message.role === 'assistant'
            && message.content.includes('Which execution path should Ariadne use for this smoke?')
          ))
          && run.interactionMessages.some((message) => (
            message.role === 'user'
            && message.content === 'local: Local only'
          ))
          && current.messages.some((message) => (
            message.runId === run.runId
            && message.role === 'assistant'
            && message.status === 'completed'
            && message.content === 'ARIADNE_SMOKE_USER_QUESTION_COMPLETED'
          ))
        ));
        const questionCardClosed = Boolean(await waitUntil(() => (
          document.querySelector('section[aria-label="Agent 需要你的输入"]') ? null : true
        )));

        lifecycleStep = 'permission_allow';
        const workspaceBeforeAllow = await listWorkspace();
        const allow = await createRun('ariadne-smoke:write_allow');
        const allowDecision = await pendingPermission(allow.runId);
        const workspaceWhileAllowPending = await listWorkspace();
        const permissionBlockedBeforeAllow = !workspaceBeforeAllow.entries.some((entry) => entry.name === 'results')
          && !workspaceWhileAllowPending.entries.some((entry) => entry.name === 'results');
        await resolvePermission(allow.runId, allowDecision, 'allow_once');
        const allowTerminal = await waitForRun(allow.runId, (run, current) => (
          run.status === 'completed'
          && run.toolActivities.some((activity) => (
            activity.toolName === 'workspace.write_file' && activity.status === 'completed'
          ))
          && current.messages.some((message) => (
            message.runId === run.runId
            && message.content === 'ARIADNE_SMOKE_WRITE_ALLOW_OK'
          ))
        ));
        const resultsAfterAllow = await listWorkspace('results');
        const permissionAllowCompleted = resultsAfterAllow.entries.some((entry) => entry.name === 'allow.txt');

        lifecycleStep = 'permission_deny';
        const deny = await createRun('ariadne-smoke:write_deny');
        const denyDecision = await pendingPermission(deny.runId);
        const resultsWhileDenyPending = await listWorkspace('results');
        const denyAbsentBeforeDecision = !resultsWhileDenyPending.entries.some((entry) => entry.name === 'deny.txt');
        await resolvePermission(deny.runId, denyDecision, 'deny');
        await waitForRun(deny.runId, (run) => ['cancelled', 'failed'].includes(run.status));
        const resultsAfterDeny = await listWorkspace('results');
        const permissionDenyPreventedEffect = denyAbsentBeforeDecision
          && !resultsAfterDeny.entries.some((entry) => entry.name === 'deny.txt');

        lifecycleStep = 'cancel';
        const cancelled = await createRun('ariadne-smoke:cancel');
        const runningCancellation = await waitForRun(cancelled.runId, (run) => run.status === 'running');
        const cancelResult = await request({
          kind: 'agent.run.cancel.v3',
          contractVersion: '3.0',
          runId: cancelled.runId,
          expectedVersion: runningCancellation.run.version,
          occurredAt: new Date().toISOString(),
          reason: 'user_requested'
        });
        const cancelledTerminal = await waitForRun(
          cancelled.runId,
          (run) => run.status === 'cancelled',
          30_000
        );

        lifecycleStep = 'crash_question';
        setValue?.call(composer, 'ariadne-smoke:crash_question');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const crashQuestionStartButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        crashQuestionStartButton.click();
        const crashedQuestion = await waitUntil(async () => {
          const current = await snapshot();
          const userMessage = current.messages.find((item) => (
            item.sessionId === direct.run.sessionId
            && item.role === 'user'
            && item.content === 'ariadne-smoke:crash_question'
          ));
          const run = userMessage
            ? current.runs.find((item) => item.sourceMessageId === userMessage.messageId)
            : undefined;
          return run?.status === 'running' ? { runId: run.runId } : null;
        });
        const questionKillAcknowledged = await waitForRuntimeKillAck('question-killed.json');
        const recoveredQuestion = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === crashedQuestion.runId);
          const decision = current.decisions.find((item) => (
            item.runId === crashedQuestion.runId
            && item.kind === 'user_question'
            && item.status === 'pending'
            && item.presentation?.kind === 'user_question'
            && item.presentation.question
              === 'Which execution path should Ariadne use for this smoke?'
            && item.action
          ));
          return run && decision ? { run, decision } : null;
        }, 90_000);
        const recoveredQuestionCard = await waitUntil(() => {
          const card = document.querySelector('section[aria-label="Agent 需要你的输入"]');
          return card?.textContent?.includes('Which execution path should Ariadne use for this smoke?')
            ? card
            : null;
        });
        const recoveredLocalAnswerButton = [...recoveredQuestionCard.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Local only');
        if (!(recoveredLocalAnswerButton instanceof HTMLButtonElement)) {
          throw new Error('recovered_user_question_local_answer_missing');
        }
        recoveredLocalAnswerButton.click();
        const recoveredQuestionTerminal = await waitForRun(
          crashedQuestion.runId,
          (run, current) => (
            run.status === 'completed'
            && run.inbox.some((input) => (
              input.source?.kind === 'user_question_answer'
              && input.source.decisionId === recoveredQuestion.decision.decisionId
              && input.content === 'local: Local only'
              && input.state === 'claimed'
            ))
            && current.messages.some((message) => (
              message.runId === run.runId
              && message.role === 'assistant'
              && message.status === 'completed'
              && message.content === 'ARIADNE_SMOKE_CRASH_USER_QUESTION_COMPLETED'
            ))
          ),
          90_000
        );
        // RuntimeSupervisor deliberately permits only three consecutive crash
        // restarts and resets that budget after 30 seconds of stable readiness.
        // Observe the production stability window after the ask-user kill so
        // the existing three-boundary crash sequence starts a fresh budget.
        await delay(31_000);
        await waitUntil(async () => {
          const runtime = await api.runtime.getStatus();
          return runtime.ok && runtime.value.availability === 'ready' ? true : null;
        });

        const crashedInference = await createRun('ariadne-smoke:crash_inference');
        await waitForRun(crashedInference.runId, (run) => run.status === 'running');
        const inferenceKillAcknowledged = await waitForRuntimeKillAck('inference-killed.json');
        const inferenceRecovery = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === crashedInference.runId);
          return run?.status === 'interrupted' ? { run, current } : null;
        }, 90_000);

        const crashedEffect = await createRun('ariadne-smoke:crash_effect');
        const crashEffectDecision = await pendingPermission(crashedEffect.runId);
        await resolvePermission(crashedEffect.runId, crashEffectDecision, 'allow_once');
        const effectKillAcknowledged = await waitForRuntimeKillAck('effect-killed.json');
        const effectRecovery = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === crashedEffect.runId);
          return run?.status === 'interrupted' ? { run, current } : null;
        }, 90_000);
        const effectCrashRecoveredWithoutReplay = effectRecovery.run.status === 'interrupted';

        const crashedProjection = await createRun('ariadne-smoke:crash_projection');
        const crashProjectionDecision = await pendingPermission(crashedProjection.runId);
        await resolvePermission(crashedProjection.runId, crashProjectionDecision, 'allow_once');
        const projectionKillAcknowledged = await waitForRuntimeKillAck('projection-killed.json');
        const projectionTerminal = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          const current = await snapshot();
          const run = current.runs.find((item) => item.runId === crashedProjection.runId);
          const assistant = current.messages.find((message) => (
            message.runId === crashedProjection.runId
            && message.role === 'assistant'
            && message.status === 'completed'
            && message.content === 'ARIADNE_SMOKE_CRASH_PROJECTION_OK'
          ));
          return run?.status === 'completed' && assistant ? { run, assistant } : null;
        }, 90_000);
        const projectionResults = await listWorkspace('results');
        const projectionCrashReplayedWithoutDuplicateEffect = projectionTerminal.run.status === 'completed'
          && projectionResults.entries.some((entry) => entry.name === 'projection-once.txt');

        const pageText = document.body.textContent ?? '';
        const readyAgentModels = initialProjection.models.filter((item) => (
          item.availability === 'ready' && item.supportsAgent
        ));
        return {
          runtimeReady: status.availability === 'ready',
          projectionReady: true,
          projectedModelCount: initialProjection.models.length,
          configuredAgentModelExclusive: readyAgentModels.length === 1
            && readyAgentModels[0]?.modelId === ${JSON.stringify(providerModel)},
          configuredModelMislabelAbsent: !pageText.includes('未配置模型'),
          newDraftDidNotCreateSession,
          composerWorkspaceSelectorVisible,
          runtimeStatusConsistent,
          conversationContextMenuVisible,
          conversationRenameProjected,
          conversationArchiveProjected,
          conversationRestoreProjected,
          sessionCreated: Boolean(direct.run.sessionId),
          messageAccepted: Boolean(direct.userMessage.messageId),
          sessionProjected: direct.current.sessions.some((item) => item.sessionId === direct.run.sessionId),
          messageProjected: direct.current.messages.some((item) => item.messageId === direct.userMessage.messageId),
          directStreamObserved: directStreamObserved.stream.runId === direct.run.runId,
          directStreamChunkCount: direct.current.inferenceStreams.find((item) => (
            item.runId === direct.run.runId
          ))?.chunks.length ?? 0,
          directAgentCompleted: direct.run.status === 'completed',
          imageAttachmentCompleted: image.run.status === 'completed',
          imageAttachmentVisible,
          inboxContinuationCompleted: inboxTerminal.run.runId === inbox.runId
            && inboxTranscriptVisible,
          agentInputDeliveryRecovered: deliveryKillAcknowledged
            && typeof deliveryCommandId === 'string'
            && deliveryCommandId === recoveredDelivery.commandId
            && recoveredDelivery.input.inputId.length > 0
            && deliveryReceiptClosed
            && deliveryInputRemoved.run.runId === questionPending.runId
            && (deliveryReconcileObserved
              ? deliveryReconcileClicked
              : recoveredDelivery.receipt.dataset.state === 'accepted'),
          deliveryRecoverySessionId: direct.run.sessionId,
          deliveryRecoveryRunId: questionPending.runId,
          userQuestionCompleted: questionTerminal.run.runId === questionPending.runId
            && questionCardClosed,
          userQuestionRuntimeRecoveryCompleted:
            recoveredQuestionTerminal.run.runId === crashedQuestion.runId,
          readToolCompleted: readTerminal.run.status === 'completed',
          permissionBlockedBeforeAllow,
          permissionAllowCompleted: permissionAllowCompleted && allowTerminal.run.status === 'completed',
          permissionDenyPreventedEffect,
          cancelCompleted: cancelResult.kind === 'agent.run.cancelled.v3'
            && cancelledTerminal.run.status === 'cancelled',
          inferenceCrashRecovered: inferenceRecovery.run.status === 'interrupted',
          effectCrashRecoveredWithoutReplay,
          projectionCrashReplayedWithoutDuplicateEffect,
          runtimeBoundaryKillsAcknowledged: deliveryKillAcknowledged
            && questionKillAcknowledged
            && inferenceKillAcknowledged
            && effectKillAcknowledged
            && projectionKillAcknowledged
        };
      } catch (error) {
        return { fatalError: error instanceof Error ? error.stack ?? error.message : String(error) };
      }
    })()`, true) as SmokeObservation;

    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true
    );
    const screenshotName = 'electron-runtime-smoke.png';
    const screenshot = await window.webContents.capturePage();
    await writeFile(join(outputRoot, screenshotName), screenshot.toPNG());
    const rendererReloadDeliveryRecovered = await verifyDeliveryRendererReload(
      window,
      observation.deliveryRecoverySessionId,
      observation.deliveryRecoveryRunId,
      workspaceId,
      outputRoot
    );
    const providerState = await readProviderState(providerStatePath);
    const providerTraceValid = validateProviderTrace(providerState);
    const result: SmokeResult = {
      passed: false,
      runtimeReady: observation.runtimeReady === true,
      projectionReady: observation.projectionReady === true,
      projectedModelCount: observation.projectedModelCount ?? 0,
      configuredAgentModelExclusive: observation.configuredAgentModelExclusive === true,
      configuredModelMislabelAbsent: observation.configuredModelMislabelAbsent === true,
      newDraftDidNotCreateSession: observation.newDraftDidNotCreateSession === true,
      composerWorkspaceSelectorVisible: observation.composerWorkspaceSelectorVisible === true,
      runtimeStatusConsistent: observation.runtimeStatusConsistent === true,
      conversationContextMenuVisible: observation.conversationContextMenuVisible === true,
      conversationRenameProjected: observation.conversationRenameProjected === true,
      conversationArchiveProjected: observation.conversationArchiveProjected === true,
      conversationRestoreProjected: observation.conversationRestoreProjected === true,
      sessionCreated: observation.sessionCreated === true,
      messageAccepted: observation.messageAccepted === true,
      sessionProjected: observation.sessionProjected === true,
      messageProjected: observation.messageProjected === true,
      directStreamObserved: observation.directStreamObserved === true,
      directStreamChunkCount: observation.directStreamChunkCount ?? 0,
      directAgentCompleted: observation.directAgentCompleted === true,
      imageAttachmentCompleted: observation.imageAttachmentCompleted === true,
      imageAttachmentVisible: observation.imageAttachmentVisible === true,
      inboxContinuationCompleted: observation.inboxContinuationCompleted === true,
      agentInputDeliveryRecovered: observation.agentInputDeliveryRecovered === true,
      rendererReloadDeliveryRecovered,
      userQuestionCompleted: observation.userQuestionCompleted === true,
      userQuestionRuntimeRecoveryCompleted:
        observation.userQuestionRuntimeRecoveryCompleted === true,
      readToolCompleted: observation.readToolCompleted === true,
      permissionBlockedBeforeAllow: observation.permissionBlockedBeforeAllow === true,
      permissionAllowCompleted: observation.permissionAllowCompleted === true,
      permissionDenyPreventedEffect: observation.permissionDenyPreventedEffect === true,
      cancelCompleted: observation.cancelCompleted === true,
      inferenceCrashRecovered: observation.inferenceCrashRecovered === true,
      effectCrashRecoveredWithoutReplay: observation.effectCrashRecoveredWithoutReplay === true,
      projectionCrashReplayedWithoutDuplicateEffect:
        observation.projectionCrashReplayedWithoutDuplicateEffect === true,
      runtimeBoundaryKillsAcknowledged: observation.runtimeBoundaryKillsAcknowledged === true,
      providerTraceValid,
      providerRequests: providerState.requests,
      providerResponses: providerState.responses,
      providerAborted: providerState.aborted,
      fatalError: observation.fatalError?.slice(0, 4_096) ?? null,
      consoleErrors,
      screenshot: screenshotName,
      completedAt: new Date().toISOString()
    };
    result.passed = result.runtimeReady
      && result.projectionReady
      && result.configuredAgentModelExclusive
      && result.configuredModelMislabelAbsent
      && result.newDraftDidNotCreateSession
      && result.composerWorkspaceSelectorVisible
      && result.runtimeStatusConsistent
      && result.conversationContextMenuVisible
      && result.conversationRenameProjected
      && result.conversationArchiveProjected
      && result.conversationRestoreProjected
      && result.sessionCreated
      && result.messageAccepted
      && result.sessionProjected
      && result.messageProjected
      && result.directStreamObserved
      && result.directStreamChunkCount >= 2
      && result.directAgentCompleted
      && result.imageAttachmentCompleted
      && result.imageAttachmentVisible
      && result.inboxContinuationCompleted
      && result.agentInputDeliveryRecovered
      && result.rendererReloadDeliveryRecovered
      && result.userQuestionCompleted
      && result.userQuestionRuntimeRecoveryCompleted
      && result.readToolCompleted
      && result.permissionBlockedBeforeAllow
      && result.permissionAllowCompleted
      && result.permissionDenyPreventedEffect
      && result.cancelCompleted
      && result.inferenceCrashRecovered
      && result.effectCrashRecoveredWithoutReplay
      && result.projectionCrashReplayedWithoutDuplicateEffect
      && result.runtimeBoundaryKillsAcknowledged
      && result.providerTraceValid
      && result.fatalError === null
      && result.consoleErrors.length === 0;
    await writeFile(
      join(outputRoot, 'electron-runtime-smoke.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    );
    return result.passed;
  } finally {
    window.webContents.removeListener('console-message', onConsoleMessage);
    window.hide();
    app.quit();
  }
}

async function verifyDeliveryRendererReload(
  window: BrowserWindow,
  sessionId: string | undefined,
  runId: string | undefined,
  workspaceId: string,
  outputRoot: string
): Promise<boolean> {
  if (!sessionId || !runId) return false;
  let step = 'stage';
  const commandId = `renderer-reload-${Date.now()}`;
  const inputId = `renderer-reload-input-${Date.now()}`;
  const content = 'ARIADNE_SMOKE_RENDERER_RELOAD_DELIVERY';
  try {
    await window.webContents.executeJavaScript(`window.ariadne.agentInputDeliveryOutbox.stage({
    commandId: ${JSON.stringify(commandId)},
    command: {
      kind: 'agent.inbox.enqueue.v3',
      contractVersion: '3.0',
      runId: ${JSON.stringify(runId)},
      sessionId: ${JSON.stringify(sessionId)},
      inputId: ${JSON.stringify(inputId)},
      delivery: 'next_turn',
      content: ${JSON.stringify(content)}
    }
    })`, true);
    await writeReloadDiagnostic(outputRoot, step, commandId);

    step = 'reload';
    const loaded = waitForLoad(window);
    window.webContents.reload();
    await loaded;
    await writeReloadDiagnostic(outputRoot, step, commandId);

    step = 'recover';
    const recovered = await window.webContents.executeJavaScript(`(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const runtime = await window.ariadne.runtime.getStatus();
      if (runtime.ok && runtime.value.availability === 'ready') break;
      await delay(50);
    }
    const workspaceSelector = '.conversation-workspace-row[data-workspace-id="'
      + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main';
    const workspace = document.querySelector(workspaceSelector);
    if (workspace instanceof HTMLButtonElement && workspace.getAttribute('aria-expanded') !== 'true') {
      workspace.click();
    }
    while (Date.now() < deadline) {
      const row = document.querySelector('.conversation-row[data-session-id="'
        + ${JSON.stringify(sessionId)} + '"] .conversation-row-main');
      if (row instanceof HTMLElement) {
        row.click();
        break;
      }
      await delay(50);
    }
    while (Date.now() < deadline) {
      const receipt = document.querySelector(
        '.agent-input-delivery[data-command-id="' + ${JSON.stringify(commandId)} + '"]'
      );
      const records = await window.ariadne.agentInputDeliveryOutbox.list();
      const record = records.find((candidate) => candidate.commandId === ${JSON.stringify(commandId)});
      if (
        receipt instanceof HTMLElement
        && receipt.dataset.state === 'reconcile'
        && receipt.textContent?.includes(${JSON.stringify(content)})
        && record?.command.inputId === ${JSON.stringify(inputId)}
        && record.command.content === ${JSON.stringify(content)}
      ) return true;
      await delay(50);
    }
    return false;
    })()`, true) as boolean;
    await writeReloadDiagnostic(outputRoot, `${step}:${String(recovered)}`, commandId);

    step = 'retain-for-desktop-restart';
    const retained = await window.webContents.executeJavaScript(`(async () => (
      (await window.ariadne.agentInputDeliveryOutbox.list())
        .some((record) => record.commandId === ${JSON.stringify(commandId)})
    ))()`, true) as boolean;
    await writeReloadDiagnostic(outputRoot, `${step}:${String(retained)}`, commandId);
    return recovered && retained;
  } catch (error) {
    throw new Error(
      `renderer_reload_delivery_failed:${step}:${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function verifyDeliveryDesktopRestart(
  window: BrowserWindow,
  workspaceId: string,
  outputRoot: string
): Promise<boolean> {
  const result: DesktopRestartDeliveryResult = {
    passed: false,
    commandId: null,
    inputId: null,
    sessionId: null,
    receiptRecovered: false,
    retainedBeforeSettlement: false,
    absentFromProjection: false,
    settled: false,
    fatalError: null,
    completedAt: new Date().toISOString()
  };
  try {
    const observation = await window.webContents.executeJavaScript(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 30_000;
      let records = [];
      while (Date.now() < deadline) {
        const runtime = await window.ariadne.runtime.getStatus();
        records = await window.ariadne.agentInputDeliveryOutbox.list();
        if (runtime.ok && runtime.value.availability === 'ready' && records.length > 0) break;
        await delay(50);
      }
      const matching = records.filter((record) => (
        record.command.content === 'ARIADNE_SMOKE_RENDERER_RELOAD_DELIVERY'
      ));
      if (matching.length !== 1) {
        throw new Error('desktop_restart_outbox_record_count:' + matching.length);
      }
      const record = matching[0];
      const workspaceSelector = '.conversation-workspace-row[data-workspace-id="'
        + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main';
      const workspace = document.querySelector(workspaceSelector);
      if (workspace instanceof HTMLButtonElement && workspace.getAttribute('aria-expanded') !== 'true') {
        workspace.click();
      }
      while (Date.now() < deadline) {
        const row = document.querySelector('.conversation-row[data-session-id="'
          + record.command.sessionId + '"] .conversation-row-main');
        if (row instanceof HTMLElement) {
          row.click();
          break;
        }
        await delay(50);
      }
      let receiptRecovered = false;
      while (Date.now() < deadline) {
        const receipt = document.querySelector(
          '.agent-input-delivery[data-command-id="' + record.commandId + '"]'
        );
        if (
          receipt instanceof HTMLElement
          && receipt.dataset.state === 'reconcile'
          && receipt.textContent?.includes(record.command.content)
        ) {
          receiptRecovered = true;
          break;
        }
        await delay(50);
      }
      const projection = await window.ariadne.runtime.request({
        kind: 'projection.snapshot.get',
        contractVersion: '3.0'
      });
      if (!projection.ok || projection.value.kind !== 'projection.snapshot') {
        throw new Error('desktop_restart_projection_unavailable');
      }
      const absentFromProjection = !projection.value.snapshot.runs.some((run) => (
        run.runId === record.command.runId
        && run.inbox.some((input) => input.inputId === record.command.inputId)
      ));
      const retainedBeforeSettlement = (await window.ariadne.agentInputDeliveryOutbox.list())
        .some((candidate) => candidate.commandId === record.commandId);
      await window.ariadne.agentInputDeliveryOutbox.settle({ commandId: record.commandId });
      const settled = !(await window.ariadne.agentInputDeliveryOutbox.list())
        .some((candidate) => candidate.commandId === record.commandId);
      return {
        commandId: record.commandId,
        inputId: record.command.inputId,
        sessionId: record.command.sessionId,
        receiptRecovered,
        retainedBeforeSettlement,
        absentFromProjection,
        settled
      };
    })()`, true) as Omit<DesktopRestartDeliveryResult, 'passed' | 'fatalError' | 'completedAt'>;
    Object.assign(result, observation);
    result.passed = result.receiptRecovered
      && result.retainedBeforeSettlement
      && result.absentFromProjection
      && result.settled;
  } catch (error) {
    result.fatalError = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  result.completedAt = new Date().toISOString();
  await writeFile(
    join(outputRoot, 'desktop-restart-delivery.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
  return result.passed;
}

async function writeReloadDiagnostic(
  outputRoot: string,
  step: string,
  commandId: string
): Promise<void> {
  await writeFile(
    join(outputRoot, 'renderer-reload-delivery.json'),
    JSON.stringify({ step, commandId }, null, 2),
    'utf8'
  );
}

async function readProviderState(path: string): Promise<ProviderState> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ProviderState;
  if (parsed.protocol !== 'ariadne-electron-smoke-provider.v1') {
    throw new Error('Electron smoke Provider state protocol is invalid.');
  }
  return parsed;
}

function validateProviderTrace(state: ProviderState): boolean {
  const expected: Record<string, readonly [number, number, number]> = {
    direct: [1, 0, 1],
    image: [1, 0, 1],
    inbox: [1, 1, 2],
    question: [1, 1, 2],
    crash_question: [1, 1, 2],
    read: [1, 1, 2],
    write_allow: [1, 1, 2],
    write_deny: [1, 0, 1],
    cancel: [1, 0, 1],
    crash_inference: [1, 0, 1],
    crash_effect: [1, 0, 1],
    crash_projection: [1, 1, 2]
  };
  for (const [scenario, [initial, continuation, requests]] of Object.entries(expected)) {
    const actual = state.scenarios[scenario];
    if (
      actual === undefined
      || actual.initialRequests !== initial
      || actual.continuationRequests !== continuation
      || actual.requests !== requests
    ) return false;
  }
  const cancelled = state.scenarios.cancel;
  return cancelled !== undefined
    && cancelled.responses === 0
    && cancelled.aborted === 1
    && state.scenarios.crash_inference?.responses === 0
    && state.scenarios.crash_inference?.aborted === 1
    && state.scenarios.crash_effect?.responses === 1
    && state.scenarios.crash_effect?.aborted === 0
    && state.scenarios.crash_projection?.responses === 2
    && state.scenarios.crash_projection?.aborted === 0
    && state.scenarios.inbox?.responses === 2
    && state.scenarios.inbox?.aborted === 0
    && state.scenarios.question?.responses === 2
    && state.scenarios.question?.aborted === 0
    && state.scenarios.crash_question?.responses === 2
    && state.scenarios.crash_question?.aborted === 0
    && state.requests === 18
    && state.responses === 16
    && state.aborted === 2;
}

function requireSmokeEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Electron smoke verification.`);
  return value;
}

async function waitForLoad(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer load failed (${code}): ${description}`));
    });
  });
}
