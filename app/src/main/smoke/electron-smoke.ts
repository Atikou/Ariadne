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
  sessionCreated: boolean;
  messageAccepted: boolean;
  sessionProjected: boolean;
  messageProjected: boolean;
  directAgentCompleted: boolean;
  inboxContinuationCompleted: boolean;
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
  sessionCreated?: boolean;
  messageAccepted?: boolean;
  sessionProjected?: boolean;
  messageProjected?: boolean;
  directAgentCompleted?: boolean;
  inboxContinuationCompleted?: boolean;
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
    const observation = await window.webContents.executeJavaScript(`(async () => {
      try {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let diagnosticSnapshot = null;
        const waitUntil = async (probe, timeoutMs = 60_000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const value = await probe();
            if (value) return value;
            await delay(50);
          }
          throw new Error('smoke_wait_timeout:' + JSON.stringify(diagnosticSnapshot));
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
            runs: value.snapshot.runs,
            messages: value.snapshot.messages,
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
        document.querySelector('.conversation-context-menu[role="menu"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
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

        const deny = await createRun('ariadne-smoke:write_deny');
        const denyDecision = await pendingPermission(deny.runId);
        const resultsWhileDenyPending = await listWorkspace('results');
        const denyAbsentBeforeDecision = !resultsWhileDenyPending.entries.some((entry) => entry.name === 'deny.txt');
        await resolvePermission(deny.runId, denyDecision, 'deny');
        await waitForRun(deny.runId, (run) => ['cancelled', 'failed'].includes(run.status));
        const resultsAfterDeny = await listWorkspace('results');
        const permissionDenyPreventedEffect = denyAbsentBeforeDecision
          && !resultsAfterDeny.entries.some((entry) => entry.name === 'deny.txt');

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
          sessionCreated: Boolean(direct.run.sessionId),
          messageAccepted: Boolean(direct.userMessage.messageId),
          sessionProjected: direct.current.sessions.some((item) => item.sessionId === direct.run.sessionId),
          messageProjected: direct.current.messages.some((item) => item.messageId === direct.userMessage.messageId),
          directAgentCompleted: direct.run.status === 'completed',
          inboxContinuationCompleted: inboxTerminal.run.runId === inbox.runId
            && inboxTranscriptVisible,
          readToolCompleted: readTerminal.run.status === 'completed',
          permissionBlockedBeforeAllow,
          permissionAllowCompleted: permissionAllowCompleted && allowTerminal.run.status === 'completed',
          permissionDenyPreventedEffect,
          cancelCompleted: cancelResult.kind === 'agent.run.cancelled.v3'
            && cancelledTerminal.run.status === 'cancelled',
          inferenceCrashRecovered: inferenceRecovery.run.status === 'interrupted',
          effectCrashRecoveredWithoutReplay,
          projectionCrashReplayedWithoutDuplicateEffect,
          runtimeBoundaryKillsAcknowledged: inferenceKillAcknowledged
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
      sessionCreated: observation.sessionCreated === true,
      messageAccepted: observation.messageAccepted === true,
      sessionProjected: observation.sessionProjected === true,
      messageProjected: observation.messageProjected === true,
      directAgentCompleted: observation.directAgentCompleted === true,
      inboxContinuationCompleted: observation.inboxContinuationCompleted === true,
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
      && result.sessionCreated
      && result.messageAccepted
      && result.sessionProjected
      && result.messageProjected
      && result.directAgentCompleted
      && result.inboxContinuationCompleted
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
    inbox: [1, 1, 2],
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
    && state.requests === 13
    && state.responses === 11
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
