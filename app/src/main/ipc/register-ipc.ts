import {
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { runtimeEventEnvelopeSchema, runtimeStatusSchema } from '@ariadne/protocol/public';
import { ZodError } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  agentSettingsMutationSchema,
  agentWorkspacePinUpdateSchema,
  agentWorkspaceRequestSchema,
  clipboardWriteRequestSchema,
  closeTerminalRequestSchema,
  createTerminalSessionRequestSchema,
  resizeTerminalRequestSchema,
  signalTerminalRequestSchema,
  agentInputDeliveryOutboxSettleRequestSchema,
  parseAgentInputDeliveryOutboxStageRequest,
  runtimeDesktopRequestSchema,
  saveLayoutRequestSchema,
  showWindowRequestSchema,
  titleBarThemeSchema,
  userPreferencesSchema,
  activateSpeechVoiceRequestSchema,
  cancelSpeechSynthesisRequestSchema,
  speechSynthesisSegmentRequestSchema,
  startSpeechRecognitionRequestSchema,
  stopSpeechRecognitionRequestSchema,
  workspaceDirectoryRequestSchema,
  writeTerminalRequestSchema
} from '@shared/schemas';
import {
  titleBarOverlayForTheme,
  windowBackgroundForTheme
} from '../windows/title-bar-appearance';
import type {
  AgentSettingsMutation,
  AgentSettingsMutationResult,
  AgentSettingsView,
  AgentWorkspacePinUpdate,
  AgentWorkspaceRequest,
  OpenWorkspaceResult,
  PublicError,
  Result,
  UserPreferences
} from '@shared/contract';
import type { AgentSettingsRepository } from '../persistence/agent-settings-repository';
import type { AgentInputDeliveryOutbox } from '../persistence/agent-input-delivery-outbox';
import type { StateRepository } from '../persistence/state-repository';
import type { SystemCapabilityCatalog } from '../services/system-capabilities';
import type { TerminalSessionService } from '../services/terminal-service';
import type { WorkspaceFileService } from '../services/workspace-file-service';
import type { MainWindowController } from '../windows/main-window';
import { RuntimeRequestError, type RuntimeSupervisor } from '../runtime/runtime-supervisor';
import type { SpeechPort } from '../speech/entity/speech-port';
import type { ActivateSpeechVoiceRequest, SpeechVoiceSummary } from '@shared/contract';

const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

interface IpcDependencies {
  getWindow(): BrowserWindow | null;
  agentSettings: AgentSettingsRepository;
  applyAgentSettings(mutation: AgentSettingsMutation): Promise<AgentSettingsMutationResult>;
  setWorkspacePinned(request: AgentWorkspacePinUpdate): Promise<AgentSettingsView>;
  archiveWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView>;
  restoreWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView>;
  updatePreferences(preferences: UserPreferences): Promise<UserPreferences>;
  addWorkspaceRoot(rootPath: string): Promise<OpenWorkspaceResult>;
  state: StateRepository;
  systemCapabilities: SystemCapabilityCatalog;
  terminals: TerminalSessionService;
  mainWindow: MainWindowController;
  runtime: RuntimeSupervisor;
  agentInputDeliveryOutbox: AgentInputDeliveryOutbox;
  speech: SpeechPort;
  activateSpeechVoice(request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary>;
  workspaceFiles: WorkspaceFileService;
  testApprovalNotification(): { shown: boolean; supported: boolean };
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const channels: string[] = Object.values(IPC_CHANNELS);
  const trusted = (event: IpcMainInvokeEvent): void => assertTrustedSender(
    event,
    dependencies.mainWindow.getPrivilegedRendererContents()
  );
  const terminalWriteListener = createValidatedTerminalListener(dependencies, writeTerminalRequestSchema, (event, request) => {
    return dependencies.terminals.write(event.sender.id, request);
  });
  const terminalResizeListener = createValidatedTerminalListener(dependencies, resizeTerminalRequestSchema, (event, request) => {
    return dependencies.terminals.resize(event.sender.id, request);
  });
  const terminalSignalListener = createValidatedTerminalListener(dependencies, signalTerminalRequestSchema, (event, request) => {
    return dependencies.terminals.signal(event.sender.id, request);
  });
  const terminalCloseListener = createValidatedTerminalListener(dependencies, closeTerminalRequestSchema, (event, request) => {
    return dependencies.terminals.close(event.sender.id, request.sessionId);
  });
  const removeRuntimeEvents = dependencies.runtime.onEvent((event) => {
    const parsed = runtimeEventEnvelopeSchema.parse(event);
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      renderer.send(IPC_CHANNELS.runtimeEvent, parsed);
    }
  });
  const removeRuntimeStatuses = dependencies.runtime.onStatus((status) => {
    const parsed = runtimeStatusSchema.parse(status);
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      renderer.send(IPC_CHANNELS.runtimeStatusChanged, parsed);
    }
  });
  const removeSpeechEvents = dependencies.speech.onEvent((speechEvent) => {
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      renderer.send(IPC_CHANNELS.speechEvent, speechEvent);
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentSettingsLoad, (event) => {
    trusted(event);
    return dependencies.agentSettings.getView();
  });

  ipcMain.handle(IPC_CHANNELS.agentSettingsApply, async (event, input: unknown) => {
    trusted(event);
    return dependencies.applyAgentSettings(agentSettingsMutationSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.agentWorkspacePinUpdate, async (event, input: unknown) => {
    trusted(event);
    return dependencies.setWorkspacePinned(agentWorkspacePinUpdateSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.agentWorkspaceArchive, async (event, input: unknown) => {
    trusted(event);
    return dependencies.archiveWorkspace(agentWorkspaceRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.agentWorkspaceRestore, async (event, input: unknown) => {
    trusted(event);
    return dependencies.restoreWorkspace(agentWorkspaceRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.systemApprovalNotificationTest, (event) => {
    trusted(event);
    return dependencies.testApprovalNotification();
  });

  ipcMain.handle(IPC_CHANNELS.clipboardWrite, (event, input: unknown) => {
    trusted(event);
    const request = clipboardWriteRequestSchema.parse(input);
    clipboard.writeText(request.text);
  });

  ipcMain.handle(IPC_CHANNELS.layoutLoad, (event) => {
    trusted(event);
    return dependencies.state.getLayout();
  });

  ipcMain.handle(IPC_CHANNELS.layoutSave, async (event, input: unknown) => {
    trusted(event);
    const request = saveLayoutRequestSchema.parse(input);
    const serialized = JSON.stringify(request.layout);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LAYOUT_BYTES) throw new Error('Layout payload is too large.');
    const savedAt = new Date().toISOString();
    await dependencies.state.saveLayout({ schemaVersion: 1, layout: request.layout, savedAt });
    return { savedAt };
  });

  ipcMain.handle(IPC_CHANNELS.preferencesLoad, (event) => {
    trusted(event);
    return dependencies.state.getPreferences();
  });

  ipcMain.handle(IPC_CHANNELS.preferencesUpdate, async (event, input: unknown) => {
    trusted(event);
    return dependencies.updatePreferences(userPreferencesSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.runtimeStatus, (event) => {
    try {
      trusted(event);
      return { ok: true, value: dependencies.runtime.getStatus() };
    } catch (error) {
      return runtimeIpcFailure(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.runtimeRequest, async (event, input: unknown) => {
    try {
      trusted(event);
      const request = runtimeDesktopRequestSchema.parse(input);
      return {
        ok: true,
        value: await dependencies.runtime.request(
          request.command,
          request.commandId ? { commandId: request.commandId } : {}
        )
      };
    } catch (error) {
      return runtimeIpcFailure(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentInputDeliveryOutboxList, (event) => {
    trusted(event);
    return dependencies.agentInputDeliveryOutbox.list();
  });

  ipcMain.handle(IPC_CHANNELS.agentInputDeliveryOutboxStage, async (event, input: unknown) => {
    trusted(event);
    return dependencies.agentInputDeliveryOutbox.stage(
      parseAgentInputDeliveryOutboxStageRequest(input)
    );
  });

  ipcMain.handle(IPC_CHANNELS.agentInputDeliveryOutboxSettle, async (event, input: unknown) => {
    trusted(event);
    const request = agentInputDeliveryOutboxSettleRequestSchema.parse(input);
    await dependencies.agentInputDeliveryOutbox.settle(request.commandId);
  });

  ipcMain.handle(IPC_CHANNELS.speechStatus, (event) => {
    trusted(event);
    return dependencies.speech.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.speechStartRecognition, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.startRecognition(startSpeechRecognitionRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.speechStopRecognition, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.stopRecognition(stopSpeechRecognitionRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.speechCancelRecognition, async (event) => {
    trusted(event);
    await dependencies.speech.cancelRecognition();
  });

  ipcMain.handle(IPC_CHANNELS.speechSynthesize, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.synthesize(speechSynthesisSegmentRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.speechCancelSynthesis, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.cancelSynthesis(cancelSpeechSynthesisRequestSchema.parse(input ?? {}));
  });

  ipcMain.handle(IPC_CHANNELS.speechVoicePackImport, async (event) => {
    trusted(event);
    const window = dependencies.getWindow();
    if (!window) throw new Error('Main window is unavailable.');
    const selection = await dialog.showOpenDialog(window, {
      title: '导入 Ariadne 语音包',
      buttonLabel: '校验并安装',
      properties: ['openFile'],
      filters: [{ name: 'Ariadne Voice Pack', extensions: ['avp'] }]
    });
    const archivePath = selection.filePaths[0];
    if (selection.canceled || !archivePath) return null;
    return dependencies.speech.installVoicePack(archivePath);
  });

  ipcMain.handle(IPC_CHANNELS.speechVoiceActivate, async (event, input: unknown) => {
    trusted(event);
    return dependencies.activateSpeechVoice(activateSpeechVoiceRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.systemCapabilityStatuses, async (event) => {
    trusted(event);
    return dependencies.systemCapabilities.getStatuses();
  });

  ipcMain.handle(IPC_CHANNELS.systemGameActivity, async (event) => {
    trusted(event);
    return dependencies.systemCapabilities.getGameActivity();
  });

  ipcMain.handle(IPC_CHANNELS.workspaceListDirectory, async (event, input: unknown) => {
    trusted(event);
    return dependencies.workspaceFiles.listDirectory(workspaceDirectoryRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceOpenDirectory, async (event) => {
    trusted(event);
    const window = dependencies.getWindow();
    if (!window) throw new Error('Main window is unavailable.');
    const selection = await dialog.showOpenDialog(window, {
      title: '打开工作区',
      buttonLabel: '打开工作区',
      properties: ['openDirectory']
    });
    const rootPath = selection.filePaths[0];
    if (selection.canceled || !rootPath) return null;
    return dependencies.addWorkspaceRoot(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.terminalCreate, (event, input: unknown) => {
    trusted(event);
    return dependencies.terminals.create(event.sender, createTerminalSessionRequestSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.terminalRecoveryList, (event) => {
    trusted(event);
    return dependencies.terminals.listRecoveryRecords();
  });
  ipcMain.on(IPC_CHANNELS.terminalWrite, terminalWriteListener);
  ipcMain.on(IPC_CHANNELS.terminalResize, terminalResizeListener);
  ipcMain.on(IPC_CHANNELS.terminalSignal, terminalSignalListener);
  ipcMain.on(IPC_CHANNELS.terminalClose, terminalCloseListener);

  ipcMain.handle(IPC_CHANNELS.windowHide, (event) => {
    trusted(event);
    dependencies.mainWindow.hide();
  });

  ipcMain.handle(IPC_CHANNELS.windowShow, async (event, input: unknown) => {
    trusted(event);
    return dependencies.mainWindow.show(showWindowRequestSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.windowTitleBarTheme, (event, input: unknown) => {
    trusted(event);
    const theme = titleBarThemeSchema.parse(input);
    nativeTheme.themeSource = theme;
    const window = dependencies.getWindow();
    const backgroundColor = windowBackgroundForTheme(theme);
    window?.setBackgroundColor(backgroundColor);
    window?.setTitleBarOverlay(titleBarOverlayForTheme(theme));
    for (const child of dependencies.mainWindow.getPopoutWindows()) child.setBackgroundColor(backgroundColor);
  });

  return () => {
    removeRuntimeEvents();
    removeRuntimeStatuses();
    removeSpeechEvents();
    ipcMain.removeListener(IPC_CHANNELS.terminalWrite, terminalWriteListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalResize, terminalResizeListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalSignal, terminalSignalListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalClose, terminalCloseListener);
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      void dependencies.terminals.closeOwnedBy(renderer.id);
    }
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function assertTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  trustedRenderers: readonly WebContents[]
): void {
  const trustedSender = trustedRenderers.find((renderer) => renderer === event.sender);
  if (!trustedSender || event.senderFrame !== trustedSender.mainFrame) {
    throw new Error('Rejected IPC from an untrusted sender.');
  }
}

function runtimeIpcFailure(error: unknown): Result<never> {
  let publicError: PublicError;
  if (error instanceof RuntimeRequestError) {
    publicError = {
      code: error.code,
      message: error.message.slice(0, 4_096),
      retryable: error.retryable,
      correlationId: error.correlationId,
      ...(error.details ? { details: [...error.details] } : {})
    };
  } else if (error instanceof ZodError) {
    publicError = {
      code: 'invalid_runtime_command',
      message: 'The Runtime command does not match the public desktop contract.',
      retryable: false,
      correlationId: randomUUID(),
      details: error.issues.slice(0, 64).map((issue) => (
        `${issue.path.join('.') || 'command'}: ${issue.message}`.slice(0, 1_024)
      ))
    };
  } else {
    publicError = {
      code: 'runtime_ipc_failed',
      message: 'The Runtime desktop request failed before an outcome was available.',
      retryable: false,
      correlationId: randomUUID()
    };
  }
  return { ok: false, error: publicError };
}

function createValidatedTerminalListener<T>(
  dependencies: IpcDependencies,
  schema: { parse(input: unknown): T },
  handle: (event: IpcMainEvent, request: T) => void | Promise<void>
): (event: IpcMainEvent, input: unknown) => void {
  return (event, input) => {
    try {
      assertTrustedSender(event, dependencies.mainWindow.getPrivilegedRendererContents());
      void Promise.resolve(handle(event, schema.parse(input))).catch((error) => {
        console.error('Rejected terminal IPC request.', error);
      });
    } catch (error) {
      console.error('Rejected terminal IPC request.', error);
    }
  };
}
