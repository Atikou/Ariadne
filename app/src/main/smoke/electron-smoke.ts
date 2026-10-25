import { app, BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { APP_TERMINAL_CONTEXT_ID } from '@shared/contract';
import { verifyInferenceStreamRecovery } from './inference-stream-recovery-smoke';
import { showSmokeWindow } from './window-visibility';
import { verifyScheduleSubmissionHistory } from './schedule-submission-history-smoke';
import { verifyFollowUpCancellation } from './follow-up-cancellation-smoke';
import { verifyRequiredChildCancellation } from './required-child-cancellation-smoke';
import { verifyEffectCancellation } from './effect-cancellation-smoke';
import { verifyWorkflowAgentExecution } from './workflow-agent-smoke';
import { verifyProductivityEditing } from './productivity-editing-smoke';
import { verifyAgentStatusDirectory } from './agent-status-ui-smoke';
import { verifyTaskCenter } from './task-center-ui-smoke';
import { TASK_CENTER_DECISION_UI_PROBE } from './task-center-decision-ui-smoke';
import { verifyGoalAutonomy } from './goal-autonomy-smoke';
import { verifyLongMemory } from './long-memory-smoke';
import { verifyModelQuality } from './model-quality-smoke';
import { verifyWorkspaceDocuments } from './workspace-documents-smoke';
import { installSmokeProjectionProbe } from './projection-probe';
import { verifyOversizedRunRecovery, type OversizedRunSmokeRecord } from './run-document-capacity-smoke';

interface SmokeResult {
  passed: boolean;
  runtimeReady: boolean;
  projectionReady: boolean;
  modelQualificationCompleted: boolean;
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
  inferenceStreamDeliveryRecovered: boolean;
  scheduleSubmissionHistoryVerified: boolean;
  followUpCancellationVerified: boolean;
  requiredChildCancellationVerified: boolean;
  effectCancellationVerified: boolean;
  workflowAgentExecutionVerified: boolean;
  productivityEditingVerified: boolean;
  agentStatusDirectoryVerified: boolean;
  goalAutonomyVerified: boolean;
  longMemoryVerified: boolean;
  modelQualityVerified: boolean;
  workspaceDocumentsVerified: boolean;
  directStreamRenderedBeforeCompletion: boolean;
  directStreamPartialText: string;
  directStreamChunkCount: number;
  directAgentCompleted: boolean;
  imageAttachmentCompleted: boolean;
  imageAttachmentVisible: boolean;
  inboxContinuationCompleted: boolean;
  agentInputDeliveryRecovered: boolean;
  rendererReloadDeliveryRecovered: boolean;
  oversizedRunDocumentVerified: boolean;
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
  modelQualificationCompleted?: boolean;
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
  directStreamRenderedBeforeCompletion?: boolean;
  directStreamPartialText?: string;
  directStreamChunkCount?: number;
  directAgentCompleted?: boolean;
  imageAttachmentCompleted?: boolean;
  imageAttachmentVisible?: boolean;
  inboxContinuationCompleted?: boolean;
  agentInputDeliveryRecovered?: boolean;
  rendererReloadDeliveryRecovered?: boolean;
  deliveryRecoverySessionId?: string;
  deliveryRecoveryRunId?: string;
  oversizedRun?: OversizedRunSmokeRecord;
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
  taskCenterQuestionSourceEvidence?: { passed: boolean };
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
  oversizedRunRestored: boolean;
  terminalInterruptedRecovered: boolean;
  terminalRecoveryVisible: boolean;
  terminalPanelVisible: boolean;
  terminalExplicitRestartLinked: boolean;
  terminalRecoverySessionId: string | null;
  terminalScreenshot: string | null;
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
  if (process.env.ARIADNE_SMOKE_DATA_RECOVERY === '1') {
    const { verifyDataRecoveryWindow } = await import('./data-recovery-smoke');
    return verifyDataRecoveryWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_FILE_DRAFTS === '1') {
    const { verifyFileDraftWindow } = await import('./file-draft-smoke');
    return verifyFileDraftWindow(window,outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_COMPOSER_KEYBOARD === '1') {
    const { verifyComposerKeyboardWindow } = await import('./composer-keyboard-smoke');
    return verifyComposerKeyboardWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_CHAT_DRAFTS === '1') {
    const { verifyChatDraftWindow } = await import('./chat-draft-smoke');
    return verifyChatDraftWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_NOTIFICATIONS === '1') {
    const { verifyDecisionNotificationWindow } = await import('./decision-notification-smoke');
    return verifyDecisionNotificationWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_DOMAIN_HEALTH === '1') {
    const { verifyDomainHealthWindow } = await import('./domain-health-smoke');
    return verifyDomainHealthWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_PROJECTION_CAPACITY === '1') {
    const { verifyProjectionCapacityWindow } = await import('./projection-capacity-smoke');
    return verifyProjectionCapacityWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_PROFILE_VERIFY === '1') {
    return verifyApplicationProfileWindow(window, outputRoot);
  }
  if (process.env.ARIADNE_SMOKE_MODULE_UI_REVISIT === 'tasks-reminder-restart') {
    const { verifyTaskNotificationRestart } = await import('./task-notification-restart-smoke');
    if (window.webContents.isLoading()) await waitForLoad(window);
    window.hide();
    await window.webContents.executeJavaScript(`(async()=>{const deadline=Date.now()+60000;
      while(Date.now()<deadline){if(window.ariadne&&(await window.ariadne.runtime.getStatus()).value?.availability==='ready')return;
      await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('task_reminder_restart_bootstrap_timeout');})()`,true);
    return verifyTaskNotificationRestart(window, outputRoot);
  }
  if (['1', 'memory', 'tasks'].includes(process.env.ARIADNE_SMOKE_MODULE_UI_REVISIT ?? '')) {
    await mkdir(outputRoot, { recursive: true });
    if (window.webContents.isLoading()) await waitForLoad(window);
    showSmokeWindow(window);
    await window.webContents.executeJavaScript(`(async()=>{const deadline=Date.now()+60000;while(Date.now()<deadline){
      if(window.__ariadneRendererCompositionRootV1?.services.runs.view.getSnapshot().runDirectory&&document.querySelector('.module-menu > button'))return;
      await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('module_revisit_bootstrap_timeout');})()`, true);
    if (process.env.ARIADNE_SMOKE_MODULE_UI_REVISIT === 'memory') {
      const sessionId = requireSmokeEnvironment('ARIADNE_SMOKE_MEMORY_REVISIT_SESSION');
      await verifyLongMemory(window, requireSmokeEnvironment('ARIADNE_SMOKE_WORKSPACE_ID'), outputRoot, sessionId);
    } else if (process.env.ARIADNE_SMOKE_MODULE_UI_REVISIT === 'tasks') await verifyTaskCenter(window, outputRoot);
    else await verifyAgentStatusDirectory(window, outputRoot);
    return true;
  }
  const providerBaseUrl = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_BASE_URL');
  const providerModel = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_MODEL');
  const providerStatePath = requireSmokeEnvironment('ARIADNE_SMOKE_PROVIDER_STATE');
  const workspaceId = requireSmokeEnvironment('ARIADNE_SMOKE_WORKSPACE_ID');
  await mkdir(outputRoot, { recursive: true });
  if (window.webContents.isLoading()) await waitForLoad(window);

  showSmokeWindow(window);
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
    await installSmokeProjectionProbe(window);
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
            try {
              const value = await probe();
              if (value) return value;
            } catch (error) {
              // Only an observed disconnect during these read-only windows is
              // retryable within the original deadline. Integrity failures fail.
              if (error?.name !== 'PublicResultError'
                || !['runtime_unavailable', 'command_outcome_uncertain'].includes(error.publicError?.code)) throw error;
            }
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
        const snapshot = async (selection = {}) => {
          const value = await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
          diagnosticSnapshot = {
            lifecycleStep,
            sessions: value.sessions,
            runs: value.runs,
            messages: value.messages,
            inferenceStreams: value.inferenceStreams,
            decisions: value.decisions,
            diagnostics: value.diagnostics,
            diagnosticCoverage: value.diagnosticCoverage,
            boundaries: value.boundaries
          };
          return value;
        };
        const createRun = async (marker) => {
          const sessionId = crypto.randomUUID();
          const messageId = crypto.randomUUID();
          const created = await request({
            kind: 'conversation.session.create',
            contractVersion: '5.0',
            sessionId,
            workspaceId: ${JSON.stringify(workspaceId)}
          });
          if (created.kind !== 'conversation.session.created') {
            throw new Error('session_create_result_invalid');
          }
          const accepted = await request({
            kind: 'conversation.message.accept',
            contractVersion: '5.0',
            sessionId,
            workspaceId: ${JSON.stringify(workspaceId)},
            expectedSessionVersion: created.version,
            messageId,
            content: marker,
            execution: { mode: 'agent', modelId: ${JSON.stringify(providerModel)} }
          });
          if (accepted.kind !== 'conversation.message.accepted') {
            throw new Error('message_accept_result_invalid');
          }
          const run = await waitUntil(async () => {
            const current = await snapshot();
            return current.runs.find((item) => item.sourceMessageId === messageId) ?? null;
          });
          return { sessionId, messageId, runId: run.runId, created, accepted };
        };
        const waitForRun = async (runId, predicate, collections = [], timeoutMs = 60_000) => waitUntil(async () => {
          const current = await snapshot({ runCollections: { [runId]: collections } });
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
          kind: 'agent.decision.resolve',
          contractVersion: '5.0',
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
        const availableProjection = await waitUntil(async () => {
          const current = await snapshot();
          return current.models.some((item) => (
            item.modelId === ${JSON.stringify(providerModel)}
            && item.availability === 'ready'
          )) ? current : null;
        });
        const qualification = await request({
          kind: 'model.qualification.run',
          contractVersion: '5.0',
          modelId: ${JSON.stringify(providerModel)}
        });
        if (
          qualification.kind !== 'model.qualification.completed'
          || qualification.modelId !== ${JSON.stringify(providerModel)}
          || qualification.supportsTextChat !== true
          || qualification.supportsAgent !== true
          || qualification.supportsPlan !== true
          || qualification.supportsVision !== true
          || qualification.qualificationState !== 'qualified'
        ) throw new Error('model_qualification_result_invalid:' + JSON.stringify(qualification));
        const initialProjection = await waitUntil(async () => {
          const current = await snapshot();
          return current.models.some((item) => (
            item.modelId === ${JSON.stringify(providerModel)}
            && item.availability === 'ready'
            && item.supportsTextChat
            && item.supportsAgent
            && item.supportsPlan
            && item.supportsVision
            && item.qualificationState === 'qualified'
          )) ? current : null;
        });

        const sessionsBeforeDraft = availableProjection.sessions.map((session) => session.sessionId).sort();
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

        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        // A different draft owner deliberately remounts its textarea. Resolve
        // the active DOM element for every input instead of retaining a node
        // across new drafts, archive/restore or selected-session transitions.
        const enterComposerText = (text) => {
          const activeComposer = document.querySelector('.composer textarea');
          if (!(activeComposer instanceof HTMLTextAreaElement) || !activeComposer.isConnected) {
            throw new Error('active_composer_missing');
          }
          if (!setValue) throw new Error('composer_value_setter_missing');
          setValue.call(activeComposer, text);
          activeComposer.dispatchEvent(new Event('input', { bubbles: true }));
        };
        enterComposerText('ariadne-smoke:direct');
        const enabledSendButton = await waitUntil(() => {
          const button = document.querySelector('.send-button');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        enabledSendButton.click();
        const directStreamPartialText = await waitUntil(() => {
          const candidates = [...document.querySelectorAll(
            '.assistant-message-content > .message-content'
          )];
          const text = candidates
            .map((candidate) => candidate.textContent?.trim() ?? '')
            .find((candidate) => (
              candidate.startsWith('ARIADNE_')
              && candidate !== 'ARIADNE_SMOKE_DIRECT_OK'
            ));
          return text ?? null;
        });
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
        enterComposerText('ariadne-smoke:image');
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
          'dialog[open][role="dialog"] .action-dialog--prompt'
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
          'dialog[open][role="alertdialog"] .action-dialog'
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
          'dialog[open][role="dialog"] .settings-dialog'
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

        lifecycleStep = 'read_tool';
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
        ), ["toolActivities"]);

        lifecycleStep = 'inbox_input_after_session_restore';
        enterComposerText('ariadne-smoke:inbox');
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
        enterComposerText('ARIADNE_SMOKE_INBOX_INPUT');
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
        )), ["inbox"]);
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
        ), ["inbox","interactionMessages"]);
        lifecycleStep = 'inbox_transcript_visible';
        // Earlier rows may be valid metadata whose bodies have not entered the
        // viewport yet. Exercise actual scroll-driven body loading before
        // checking the complete small transcript in the DOM.
        const inboxViewport = document.querySelector('.message-viewport');
        if (inboxViewport instanceof HTMLElement) {
          for (let top = 0, step = 0; step < 32 && top < inboxViewport.scrollHeight; step++, top += Math.max(1, inboxViewport.clientHeight * 0.8)) {
            inboxViewport.scrollTo({ top }); await delay(100);
          }
          inboxViewport.scrollTo({ top: inboxViewport.scrollHeight });
        }
        const inboxTranscriptVisible = Boolean(await waitUntil(() => {
          const text = document.querySelector('.chat-panel')?.textContent ?? '';
          return text.includes('ARIADNE_SMOKE_INBOX_FIRST')
            && text.includes('ARIADNE_SMOKE_INBOX_INPUT')
            && text.includes('ARIADNE_SMOKE_INBOX_FINAL');
        }));

        lifecycleStep = 'question_delivery_recovery';
        enterComposerText('ariadne-smoke:question');
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
        window.__taskCenterQuestionSourceEvidence=await ${TASK_CENTER_DECISION_UI_PROBE}(${JSON.stringify(workspaceId)},direct.run.sessionId,questionPending.runId,questionPending.decisionId,'user_question');
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
        enterComposerText('ARIADNE_SMOKE_DELIVERY_INPUT');
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
          const current = await snapshot({ runCollections: { [questionPending.runId]: ['inbox'] } });
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
        ), ["inbox"]);
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
        ), ["inbox","interactionMessages"]);
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
        ), ["toolActivities"]);
        const resultsAfterAllow = await listWorkspace('results');
        const permissionAllowCompleted = resultsAfterAllow.entries.some((entry) => entry.name === 'allow.txt');

        lifecycleStep = 'permission_deny';
        const deny = await createRun('ariadne-smoke:write_deny');
        const denyDecision = await pendingPermission(deny.runId);
        lifecycleStep = 'oversized_run_document';
        const oversizedContent = '【模拟超大权威输入】汉字'.repeat(8000);
        const oversizedInputIds = Array.from({ length: 5 }, () => crypto.randomUUID());
        for (const inputId of oversizedInputIds) {
          const accepted = await request({ kind: 'agent.inbox.enqueue', contractVersion: '5.0',
            runId: deny.runId, sessionId: deny.sessionId, inputId, delivery: 'next_turn', content: oversizedContent });
          if (accepted.kind !== 'agent.inbox.enqueued' || accepted.inputId !== inputId) throw new Error('oversized_input_not_accepted');
        }
        const oversizedQueued = await waitForRun(deny.runId, run => run.inbox.length === 5
          && oversizedInputIds.every(id => run.inbox.some(input => input.inputId === id && input.content === oversizedContent)), ['inbox']);
        const serializedInboxBytes = new TextEncoder().encode(JSON.stringify(oversizedQueued.run.inbox)).length;
        if (serializedInboxBytes <= 1024 * 1024) throw new Error('oversized_run_fixture_too_small');
        const oversizedSession = await waitUntil(() => document.querySelector('.conversation-row[data-session-id="'
          + deny.sessionId + '"] .conversation-row-main'));
        oversizedSession.click();
        for (let index = 0; index < 5; index++) {
          const row = await waitUntil(() => document.querySelectorAll('.agent-inbox-row')[index]);
          row.scrollIntoView({ block: 'nearest' });
          await waitUntil(() => row.querySelector('.agent-inbox-content')?.textContent === oversizedContent);
        }
        const visibleCompleteBodies = [...document.querySelectorAll('.agent-inbox-content')]
          .filter(node => node.textContent === oversizedContent).length === 5;
        if (!visibleCompleteBodies) throw new Error('oversized_run_body_dom_incomplete');
        const originalSession = await waitUntil(() => document.querySelector('.conversation-row[data-session-id="'
          + direct.run.sessionId + '"] .conversation-row-main'));
        originalSession.click();
        await waitUntil(() => document.querySelector('.chat-panel[aria-busy="false"]')
          && document.querySelector('.conversation-row[data-session-id="' + direct.run.sessionId + '"].is-active'));
        lifecycleStep = 'permission_deny';
        const resultsWhileDenyPending = await listWorkspace('results');
        const denyAbsentBeforeDecision = !resultsWhileDenyPending.entries.some((entry) => entry.name === 'deny.txt');
        await resolvePermission(deny.runId, denyDecision, 'deny');
        await waitForRun(deny.runId, (run) => ['cancelled', 'failed'].includes(run.status), []);
        const resultsAfterDeny = await listWorkspace('results');
        const permissionDenyPreventedEffect = denyAbsentBeforeDecision
          && !resultsAfterDeny.entries.some((entry) => entry.name === 'deny.txt');

        lifecycleStep = 'cancel';
        const cancelled = await createRun('ariadne-smoke:cancel');
        const runningCancellation = await waitForRun(cancelled.runId, (run) => run.status === 'running', []);
        const cancelResult = await request({
          kind: 'agent.run.cancel',
          contractVersion: '5.0',
          runId: cancelled.runId,
          expectedVersion: runningCancellation.run.version,
          occurredAt: new Date().toISOString(),
          reason: 'user_requested'
        });
        const cancelledTerminal = await waitForRun(
          cancelled.runId,
          (run) => run.status === 'cancelled', [],
          30_000
        );

        lifecycleStep = 'crash_question';
        enterComposerText('ariadne-smoke:crash_question');
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
          ), ["inbox"],
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
        const inferenceActive = await waitForRun(crashedInference.runId, (run) => run.status === 'running', []);
        // The Provider holds this request open. Arm the native kill only after
        // the shipped read path has actually observed its running projection.
        const inferenceObservationId = crypto.randomUUID();
        const inferenceObservationContent = JSON.stringify({ format: 'ariadne-smoke-inference-observed.v1',
          commandId: inferenceObservationId, runId: inferenceActive.run.runId,
          runVersion: inferenceActive.run.version, status: inferenceActive.run.status });
        const inferenceObserved = await api.runtime.request({ kind: 'workspace.document.save', contractVersion: '5.0',
          workspaceId: ${JSON.stringify(workspaceId)}, path: 'runtime-kills/inference-observed.json', expectedVersion: null,
          content: inferenceObservationContent }, { commandId: inferenceObservationId });
        if (inferenceObserved.ok ? inferenceObserved.value.kind !== 'workspace.document.saved'
          : inferenceObserved.error.code !== 'command_outcome_uncertain') throw new Error('inference_observation_marker_not_saved');
        const inferenceKillAcknowledged = await waitForRuntimeKillAck('inference-killed.json');
        // If the deliberate kill falls between file commit and reply, reconcile
        // the exact written evidence after restart; never resend this write.
        const inferenceRecovery = await waitUntilAcrossRuntimeRestart(async () => {
          const runtime = await api.runtime.getStatus();
          if (!runtime.ok || runtime.value.availability !== 'ready') return null;
          if (!inferenceObserved.ok) {
            const marker = await request({ kind: 'workspace.document.read', contractVersion: '5.0',
              workspaceId: ${JSON.stringify(workspaceId)}, path: 'runtime-kills/inference-observed.json' });
            if (marker.kind !== 'workspace.document.read_result' || marker.content !== inferenceObservationContent) {
              throw new Error('inference_observation_unknown_outcome_not_reconciled');
            }
          }
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

        lifecycleStep = 'renderer_recovery_read_ranges';
        await waitUntil(() => document.querySelector('.chat-panel[aria-busy="false"]'));
        const pageText = document.body.textContent ?? '';
        const readyAgentModels = initialProjection.models.filter((item) => (
          item.availability === 'ready' && item.supportsAgent
        ));
        const oversizedRecovered = await waitForRun(deny.runId, run => ['failed', 'cancelled'].includes(run.status)
          && run.inbox.length === 5 && oversizedInputIds.every(id => run.inbox.some(input => input.inputId === id
            && input.content === oversizedContent && input.state === 'queued')), ['inbox']);
        return {
          oversizedRun: { runId: deny.runId, sessionId: deny.sessionId, inputIds: oversizedInputIds,
            serializedInboxBytes, perItemUtf16Length: oversizedContent.length, visibleCompleteBodies,
            restoredAfterRuntimeKills: oversizedRecovered.run.runId === deny.runId },
          runtimeReady: status.availability === 'ready',
          projectionReady: true,
          modelQualificationCompleted: qualification.qualificationState === 'qualified',
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
          directStreamRenderedBeforeCompletion: directStreamPartialText.length > 0,
          directStreamPartialText,
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
          taskCenterQuestionSourceEvidence: window.__taskCenterQuestionSourceEvidence,
          userQuestionRuntimeRecoveryCompleted:
            recoveredQuestionTerminal.run.runId === crashedQuestion.runId,
          readToolCompleted: readTerminal.run.status === 'completed',
          permissionBlockedBeforeAllow,
          permissionAllowCompleted: permissionAllowCompleted && allowTerminal.run.status === 'completed',
          permissionDenyPreventedEffect,
          cancelCompleted: cancelResult.kind === 'agent.run.cancelled'
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

    let oversizedRunDocumentVerified = false;
    if (observation.oversizedRun !== undefined && observation.fatalError === undefined) {
      await writeFile(join(outputRoot, 'oversized-run-document.json'), JSON.stringify(observation.oversizedRun, null, 2), 'utf8');
      try { oversizedRunDocumentVerified = await verifyOversizedRunRecovery(window, workspaceId, outputRoot, 'renderer-reload'); }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }

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
    let inferenceStreamDeliveryRecovered = false;
    let scheduleSubmissionHistoryVerified = false;
    let followUpCancellationVerified = false;
    let requiredChildCancellationVerified = false;
    let effectCancellationVerified = false;
    let workflowAgentExecutionVerified = false;
    let productivityEditingVerified = false;
    let agentStatusDirectoryVerified = false;
    let goalAutonomyVerified = false;
    let longMemoryVerified = false;
    let modelQualityVerified = false;
    let workspaceDocumentsVerified = false;
    if (observation.fatalError === undefined) {
      try { inferenceStreamDeliveryRecovered = await verifyInferenceStreamRecovery(window, providerModel, outputRoot); }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyScheduleSubmissionHistory(window, workspaceId, outputRoot); scheduleSubmissionHistoryVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyFollowUpCancellation(window, workspaceId, providerModel, outputRoot); followUpCancellationVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyRequiredChildCancellation(window, workspaceId, providerModel, outputRoot); requiredChildCancellationVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyEffectCancellation(window, workspaceId, providerModel, outputRoot); effectCancellationVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyWorkflowAgentExecution(window, workspaceId, outputRoot); workflowAgentExecutionVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try {
        if (!observation.deliveryRecoverySessionId) throw new Error('productivity_editing_fixture_session_missing');
        await verifyProductivityEditing(window, workspaceId, outputRoot, observation.deliveryRecoverySessionId); productivityEditingVerified = true;
      }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyAgentStatusDirectory(window, outputRoot); agentStatusDirectoryVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try {
        await verifyTaskCenter(window, outputRoot);
        const decisions={ permission:await window.webContents.executeJavaScript('window.__taskCenterPermissionSourceEvidence'),
          question:observation.taskCenterQuestionSourceEvidence };
        if(!decisions.permission?.passed||!decisions.question?.passed)throw new Error('task_center_original_decision_evidence_missing');
        await writeFile(join(outputRoot,'task-center-source-decisions.json'),JSON.stringify(decisions,null,2),'utf8');
      } catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyGoalAutonomy(window, workspaceId, outputRoot); goalAutonomyVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyLongMemory(window, workspaceId, outputRoot); longMemoryVerified = true; }
      catch (error) { observation.fatalError = error instanceof Error ? error.message : String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyModelQuality(window,workspaceId,providerModel,outputRoot); modelQualityVerified=true; }
      catch(error) { observation.fatalError=error instanceof Error?error.message:String(error); }
    }
    if (observation.fatalError === undefined) {
      try { await verifyWorkspaceDocuments(window,workspaceId,outputRoot); workspaceDocumentsVerified=true; }
      catch(error) { observation.fatalError=error instanceof Error?error.message:String(error); }
    }
    // The Provider persists counters after closing each response. The final
    // Runtime/Renderer assertion can win that race by a few milliseconds, so
    // wait for the complete trace before evaluating the external fixture.
    const providerState = await waitForProviderTrace(providerStatePath);
    const providerTraceValid = validateProviderTrace(providerState);
    const result: SmokeResult = {
      passed: false,
      runtimeReady: observation.runtimeReady === true,
      projectionReady: observation.projectionReady === true,
      modelQualificationCompleted: observation.modelQualificationCompleted === true,
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
      inferenceStreamDeliveryRecovered,
      scheduleSubmissionHistoryVerified,
      followUpCancellationVerified,
      requiredChildCancellationVerified,
      effectCancellationVerified,
      workflowAgentExecutionVerified,
      productivityEditingVerified,
      agentStatusDirectoryVerified,
      goalAutonomyVerified,
      longMemoryVerified,
      modelQualityVerified,
      workspaceDocumentsVerified,
      directStreamRenderedBeforeCompletion:
        observation.directStreamRenderedBeforeCompletion === true,
      directStreamPartialText: observation.directStreamPartialText ?? '',
      directStreamChunkCount: observation.directStreamChunkCount ?? 0,
      directAgentCompleted: observation.directAgentCompleted === true,
      imageAttachmentCompleted: observation.imageAttachmentCompleted === true,
      imageAttachmentVisible: observation.imageAttachmentVisible === true,
      inboxContinuationCompleted: observation.inboxContinuationCompleted === true,
      agentInputDeliveryRecovered: observation.agentInputDeliveryRecovered === true,
      rendererReloadDeliveryRecovered,
      oversizedRunDocumentVerified,
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
      && result.modelQualificationCompleted
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
      && result.inferenceStreamDeliveryRecovered
      && result.scheduleSubmissionHistoryVerified
      && result.followUpCancellationVerified
      && result.requiredChildCancellationVerified
      && result.effectCancellationVerified
      && result.workflowAgentExecutionVerified
      && result.productivityEditingVerified
      && result.agentStatusDirectoryVerified
      && result.goalAutonomyVerified
      && result.longMemoryVerified
      && result.modelQualityVerified
      && result.workspaceDocumentsVerified
      && result.directStreamRenderedBeforeCompletion
      && result.directStreamChunkCount >= 2
      && result.directAgentCompleted
      && result.imageAttachmentCompleted
      && result.imageAttachmentVisible
      && result.inboxContinuationCompleted
      && result.agentInputDeliveryRecovered
      && result.rendererReloadDeliveryRecovered
      && result.oversizedRunDocumentVerified
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
    if (process.env.ARIADNE_SMOKE_FORCE_MAIN_CRASH_AFTER_RESULT !== '1') app.quit();
  }
}

async function verifyApplicationProfileWindow(
  window: BrowserWindow,
  outputRoot: string
): Promise<boolean> {
  await mkdir(outputRoot, { recursive: true });
  if (window.webContents.isLoading()) await waitForLoad(window);
  showSmokeWindow(window);
  const consoleMessages: string[] = [];
  const onConsoleMessage = (
    _event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    level: number,
    message: string
  ): void => {
    if (level >= 2) consoleMessages.push(message.slice(0, 1_024));
  };
  window.webContents.on('console-message', onConsoleMessage);
  const expectedProfile = process.env.ARIADNE_APPLICATION_PROFILE ?? 'desktop-default';
  const observation = await window.webContents.executeJavaScript(`(async () => {
    let step = 'profile';
    try {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitUntil = async (probe) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = await probe();
        if (result) return result;
        await delay(50);
      }
      throw new Error('profile_window_timeout');
    };
    const profile = await window.ariadne.system.getApplicationProfile();
    step = 'composer';
    const chatButton = await waitUntil(() => document.querySelector('.activity-bar button[aria-label="对话"]'));
    chatButton.click();
    const composer = await waitUntil(() => document.querySelector('[aria-label="消息输入框"]'));
    step = 'settings';
    const settingsButton = await waitUntil(() => document.querySelector('.activity-bar button[aria-label="设置"]'));
    settingsButton.click();
    await waitUntil(() => document.querySelector('.settings-navigation'));
    const speechIds = profile.entities.find((entry) => entry.entity === 'speech').componentIds;
    const uiIds = profile.entities.find((entry) => entry.entity === 'ui').componentIds;
    const mic = document.querySelector('.composer-mic-button');
    const speechCategory = [...document.querySelectorAll('.settings-navigation-item')]
      .some((item) => item.textContent?.includes('本地语音'));
    step = 'visual-review';
    const closeSettingsButton = await waitUntil(() => document.querySelector('button[aria-label="关闭设置"]'));
    closeSettingsButton.click();
    await waitUntil(() => document.querySelector('.settings-dialog') === null);
    const expectsVisualReview = uiIds.includes('review.visual');
    let reviewPanel = null;
    if (expectsVisualReview) {
    const reviewButton = await waitUntil(() => document.querySelector('.activity-bar button[aria-label="可视化审查"]'));
    reviewButton.click();
    reviewPanel = await waitUntil(() => document.querySelector('.visual-review-panel'));
    }
    await delay(250);
    const reopenedSettingsButton = document.querySelector('button[aria-label="关闭设置"]');
    if (reopenedSettingsButton) {
      reopenedSettingsButton.click();
      await waitUntil(() => document.querySelector('.settings-dialog') === null);
    }
    await delay(100);
    const sequenceRect = document.querySelector('.review-sequence')?.getBoundingClientRect();
    const boardRect = document.querySelector('.review-sequence-board')?.getBoundingClientRect();
    const participantRects = [...document.querySelectorAll('.review-participant')].map((item) => ({
      label: item.querySelector('strong')?.textContent ?? '',
      left: Math.round(item.getBoundingClientRect().left),
      right: Math.round(item.getBoundingClientRect().right)
    }));
    return {
      profileId: profile.id,
      profileDigest: profile.digest,
      entityDigestsValid: profile.entities.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest)),
      composerVisible: Boolean(composer),
      runtimeHealthProfileAbsent: !uiIds.includes('runtime.health'),
      runtimeHealthDomAbsent: document.querySelector('[data-module-id="runtime.health"]') === null
        && !document.body.textContent?.includes('Runtime 健康'),
      micVisible: Boolean(mic),
      speechCategoryVisible: speechCategory,
      visualReviewVisible: Boolean(reviewPanel),
      visualReviewNavigationVisible: document.querySelector('.activity-bar button[aria-label="可视化审查"]') !== null,
      expectsVisualReview,
      visualReviewMarkedAsLive: document.body.textContent?.includes('真实会话数据') === true
        || document.body.textContent?.includes('选择一个会话后') === true,
      visualReviewLayout: {
        sequenceWidth: Math.round(sequenceRect?.width ?? 0),
        boardWidth: Math.round(boardRect?.width ?? 0),
        participants: participantRects
      },
      expectsStt: speechIds.includes('speech.stt'),
      expectsSpeechUi: speechIds.some((id) => id !== 'speech.core')
    };
    } catch (error) {
      return {
        fatalError: error instanceof Error ? error.message : String(error),
        step,
        bodyText: document.body.innerText.slice(0, 4000)
      };
    }
  })()`, true) as {
    fatalError?: string;
    step?: string;
    bodyText?: string;
    profileId: string;
    profileDigest: string;
    entityDigestsValid: boolean;
    composerVisible: boolean;
    runtimeHealthProfileAbsent: boolean;
    runtimeHealthDomAbsent: boolean;
    micVisible: boolean;
    speechCategoryVisible: boolean;
    visualReviewVisible: boolean;
    visualReviewNavigationVisible: boolean;
    expectsVisualReview: boolean;
    visualReviewMarkedAsLive: boolean;
    visualReviewLayout: {
      sequenceWidth: number;
      boardWidth: number;
      participants: Array<{ label: string; left: number; right: number }>;
    };
    expectsStt: boolean;
    expectsSpeechUi: boolean;
  };
  const screenshotPath = join(outputRoot, 'profile-window.png');
  const screenshot = await window.webContents.capturePage();
  await writeFile(screenshotPath, screenshot.toPNG());
  const passed = observation.profileId === expectedProfile
    && observation.fatalError === undefined
    && /^sha256:[a-f0-9]{64}$/u.test(observation.profileDigest)
    && observation.entityDigestsValid
    && observation.composerVisible
    && observation.runtimeHealthProfileAbsent
    && observation.runtimeHealthDomAbsent
    && observation.expectsVisualReview === (expectedProfile === 'desktop-preview')
    && observation.visualReviewVisible === observation.expectsVisualReview
    && observation.visualReviewNavigationVisible === observation.expectsVisualReview
    && observation.visualReviewMarkedAsLive === observation.expectsVisualReview
    && observation.micVisible === observation.expectsStt
    && observation.speechCategoryVisible === observation.expectsSpeechUi;
  await writeFile(join(outputRoot, 'profile-window.json'), JSON.stringify({
    passed,
    expectedProfile,
    ...observation,
    consoleMessages,
    screenshot: screenshotPath,
    completedAt: new Date().toISOString()
  }, null, 2));
  window.webContents.off('console-message', onConsoleMessage);
  return passed;
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
    await window.webContents.executeJavaScript(`window.ariadne.inputDeliveryOutbox.stage({
    commandId: ${JSON.stringify(commandId)},
    command: {
      kind: 'agent.inbox.enqueue',
      contractVersion: '5.0',
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
    await installSmokeProjectionProbe(window);
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
      const records = await window.ariadne.inputDeliveryOutbox.list();
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
      (await window.ariadne.inputDeliveryOutbox.list())
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
    oversizedRunRestored: false,
    terminalInterruptedRecovered: false,
    terminalRecoveryVisible: false,
    terminalPanelVisible: false,
    terminalExplicitRestartLinked: false,
    terminalRecoverySessionId: null,
    terminalScreenshot: null,
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
        records = await window.ariadne.inputDeliveryOutbox.list();
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
      const absentFromProjection = await window.__ariadneSmokeProjection.inboxAbsent(
        ${JSON.stringify(workspaceId)}, record.command.sessionId, record.command.runId, record.command.inputId
      );
      const retainedBeforeSettlement = (await window.ariadne.inputDeliveryOutbox.list())
        .some((candidate) => candidate.commandId === record.commandId);
      await window.ariadne.inputDeliveryOutbox.settle({ commandId: record.commandId });
      const settled = !(await window.ariadne.inputDeliveryOutbox.list())
        .some((candidate) => candidate.commandId === record.commandId);
      const terminalRecords = await window.ariadne.terminal.listRecoveryRecords();
      const interruptedTerminal = terminalRecords.find((candidate) => (
        candidate.workspaceId === ${JSON.stringify(APP_TERMINAL_CONTEXT_ID)}
        && candidate.status === 'interrupted'
        && candidate.detail === 'main_process_lost'
      ));
      const terminalInterruptedRecovered = interruptedTerminal !== undefined;
      const terminalTab = Array.from(document.querySelectorAll('.module-tab')).find((candidate) => (
        candidate instanceof HTMLElement
        && (candidate.dataset.moduleId === 'terminal' || candidate.textContent?.trim() === '终端')
      ));
      if (terminalTab instanceof HTMLElement) {
        terminalTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      await delay(100);
      let recoveryBanner = null;
      let visibleTerminalPanel = null;
      const recoveryDeadline = Date.now() + 10_000;
      while (Date.now() < recoveryDeadline) {
        visibleTerminalPanel = Array.from(document.querySelectorAll('.terminal-panel')).find((candidate) => (
          candidate instanceof HTMLElement
          && candidate.getBoundingClientRect().height > 0
          && getComputedStyle(candidate).visibility !== 'hidden'
        )) ?? null;
        const candidate = visibleTerminalPanel?.querySelector('.terminal-recovery') ?? null;
        if (
          candidate instanceof HTMLElement
          && candidate.getBoundingClientRect().height > 0
          && getComputedStyle(candidate).visibility !== 'hidden'
          && candidate.textContent?.includes('命令不会自动重放')
        ) {
          recoveryBanner = candidate;
          break;
        }
        await delay(50);
      }
      const terminalRecoveryVisible = recoveryBanner !== null;
      const terminalPanelVisible = visibleTerminalPanel instanceof HTMLElement;
      return {
        commandId: record.commandId,
        inputId: record.command.inputId,
        sessionId: record.command.sessionId,
        receiptRecovered,
        retainedBeforeSettlement,
        absentFromProjection,
        settled,
        terminalInterruptedRecovered,
        terminalRecoveryVisible,
        terminalPanelVisible,
        terminalRecoverySessionId: interruptedTerminal?.sessionId ?? null
      };
    })()`, true) as Omit<DesktopRestartDeliveryResult, 'passed' | 'fatalError' | 'completedAt'>;
    Object.assign(result, observation);
    result.oversizedRunRestored = await verifyOversizedRunRecovery(window, workspaceId, outputRoot, 'main-restart');
    const terminalScreenshot = 'terminal-main-crash-recovery.png';
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true
    );
    await writeFile(join(outputRoot, terminalScreenshot), (await window.webContents.capturePage()).toPNG());
    result.terminalScreenshot = terminalScreenshot;
    result.terminalExplicitRestartLinked = await window.webContents.executeJavaScript(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const restart = Array.from(document.querySelectorAll('.terminal-panel')).find((candidate) => (
        candidate instanceof HTMLElement
        && candidate.getBoundingClientRect().height > 0
        && getComputedStyle(candidate).visibility !== 'hidden'
      ))?.querySelector('.terminal-recovery button');
      if (!(restart instanceof HTMLButtonElement)) return false;
      restart.click();
      const confirmationDeadline = Date.now() + 5_000;
      let confirmed = false;
      while (Date.now() < confirmationDeadline) {
        const dialog = Array.from(document.querySelectorAll('dialog[open][role="alertdialog"]')).find(
          (candidate) => candidate.querySelector('h2')?.textContent === '重新启动终端？'
        );
        const confirm = dialog && Array.from(dialog.querySelectorAll('button')).find(
          (candidate) => candidate.textContent === '重新启动'
        );
        if (confirm instanceof HTMLButtonElement) {
          confirm.click();
          confirmed = true;
          break;
        }
        await delay(50);
      }
      if (!confirmed) throw new Error('terminal_restart_confirmation_missing');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const linked = (await window.ariadne.terminal.listRecoveryRecords()).some((candidate) => (
          candidate.restartOf === ${JSON.stringify(result.terminalRecoverySessionId)}
          && candidate.status === 'running'
        ));
        if (linked) return true;
        await delay(50);
      }
      return false;
    })()`, true) as boolean;
    result.passed = result.receiptRecovered
      && result.retainedBeforeSettlement
      && result.absentFromProjection
      && result.settled
      && result.oversizedRunRestored
      && result.terminalInterruptedRecovered
      && result.terminalRecoveryVisible
      && result.terminalPanelVisible
      && result.terminalExplicitRestartLinked;
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

async function waitForProviderTrace(path: string, timeoutMs = 5_000): Promise<ProviderState> {
  let state = await readProviderState(path);
  const deadline = Date.now() + timeoutMs;
  while (!validateProviderTrace(state) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state = await readProviderState(path);
  }
  return state;
}

function validateProviderTrace(state: ProviderState): boolean {
  const expected: Record<string, readonly [number, number, number]> = {
    stream_recovery: [2, 0, 2],
    direct: [2, 0, 2],
    quality_benchmark: [6, 0, 6], quality_route: [1, 0, 1],
    document_edit_conflict: [1, 2, 3],
    image: [1, 0, 1],
    inbox: [1, 1, 2],
    question: [1, 1, 2],
    crash_question: [1, 1, 2],
    read: [1, 1, 2],
    write_allow: [1, 1, 2],
    write_deny: [1, 0, 1],
    cancel_follow_up: [1, 1, 2],
    cancel_required_parent: [1, 0, 1],
    cancel_required_child: [1, 0, 1],
    cancel_effect: [1, 0, 1],
    schedule_complete: [1, 0, 1], schedule_cancel: [1, 0, 1],
    memory_stage: [1, 3, 4], memory_read: [1, 1, 2], memory_forget: [1, 1, 2],
    crash_inference: [1, 0, 1],
    crash_effect: [1, 0, 1],
    crash_projection: [1, 1, 2],
    workflow_context_seed: [1, 0, 1],
    workflow_context_later: [1, 0, 1],
    goal_context_seed: [2, 0, 2], goal_context_later: [1, 0, 1], goal_plan: [3, 5, 8],
    goal_task_first: [1, 1, 2], goal_task_repair: [1, 1, 2], goal_pause_plan: [1, 1, 2], goal_pause_task: [1, 0, 1]
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
  const cancelTraceValid = cancelled !== undefined && (
    (cancelled.requests === 0 && cancelled.responses === 0 && cancelled.aborted === 0)
    || (cancelled.requests === 1 && cancelled.responses === 0 && cancelled.aborted === 1)
  );
  return cancelTraceValid
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
    && state.scenarios.stream_recovery?.responses === 2
    && state.scenarios.cancel_follow_up?.responses === 1
    && state.scenarios.cancel_follow_up?.aborted === 1
    && state.scenarios.cancel_required_parent?.responses === 1
    && state.scenarios.cancel_required_parent?.aborted === 0
    && state.scenarios.cancel_required_child?.responses === 0
    && state.scenarios.cancel_required_child?.aborted === 1
    && state.scenarios.cancel_effect?.responses === 1
    && state.scenarios.cancel_effect?.aborted === 0
    && state.scenarios.schedule_complete?.responses === 1 && state.scenarios.schedule_complete?.aborted === 0
    && state.scenarios.schedule_cancel?.responses === 1 && state.scenarios.schedule_cancel?.aborted === 0
    && state.scenarios.workflow_complete?.responses === 3
    && state.scenarios.workflow_complete?.aborted === 0
    && state.scenarios.workflow_cancel?.responses === 1
    && state.scenarios.workflow_cancel?.aborted === 0
    && state.scenarios.workflow_context_seed?.responses === 1
    && state.scenarios.workflow_context_seed?.aborted === 0
    && state.scenarios.workflow_context_later?.responses === 1
    && state.scenarios.workflow_context_later?.aborted === 0
    && state.scenarios.goal_plan?.responses === 8 && state.scenarios.goal_plan?.aborted === 0
    && state.scenarios.goal_task_first?.responses === 2 && state.scenarios.goal_task_first?.aborted === 0
    && state.scenarios.goal_task_repair?.responses === 2 && state.scenarios.goal_task_repair?.aborted === 0
    && state.scenarios.goal_pause_plan?.responses === 2 && state.scenarios.goal_pause_plan?.aborted === 0
    && state.scenarios.goal_pause_task?.responses === 1 && state.scenarios.goal_pause_task?.aborted === 0
    && state.scenarios.goal_context_seed?.responses === 2 && state.scenarios.goal_context_seed?.aborted === 0
    && state.scenarios.goal_context_later?.responses === 1 && state.scenarios.goal_context_later?.aborted === 0
    && ['memory_stage','memory_read','memory_forget'].every(scenario => state.scenarios[scenario]?.aborted === 0
      && state.scenarios[scenario]?.responses === (scenario === 'memory_stage' ? 4 : 2))
    && state.scenarios.quality_benchmark?.responses===6 && state.scenarios.quality_benchmark?.aborted===0
    && state.scenarios.quality_route?.responses===1 && state.scenarios.quality_route?.aborted===0
    && state.scenarios.document_edit_conflict?.responses===3 && state.scenarios.document_edit_conflict?.aborted===0
    && (state.requests === 69 || state.requests === 70)
    && state.responses === 66
    && (state.aborted === 3 || state.aborted === 4);
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
