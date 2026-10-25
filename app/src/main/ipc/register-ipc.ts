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
import { chatDraftAttachmentReadSchema, chatDraftMoveSchema, chatDraftWriteSchema } from '@shared/chat-drafts';
import type { ChatDraftRepository } from '../persistence/chat-draft-repository';
import { fileDraftReplaceSchema, fileDraftPathRequestSchema } from '@shared/file-drafts';
import type { FileDraftRepository } from '../persistence/file-draft-repository';
import {
  agentSettingsMutationSchema,
  agentWorkspacePinUpdateSchema,
  agentWorkspaceRequestSchema,
  clipboardWriteRequestSchema,
  closeTerminalRequestSchema,
  createTerminalSessionRequestSchema,
  resizeTerminalRequestSchema,
  signalTerminalRequestSchema,
  inputDeliveryOutboxSettleRequestSchema,
  parseInputDeliveryOutboxStageRequest,
  parseInputDeliveryOutboxBatch,
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
  ApplicationProfileView,
  AgentWorkspacePinUpdate,
  AgentWorkspaceRequest,
  OpenWorkspaceResult,
  PublicError,
  Result,
  UserPreferences
} from '@shared/contract';
import type { AgentSettingsRepository } from '../persistence/agent-settings-repository';
import type { InputDeliveryOutbox } from '../persistence/input-delivery-outbox';
import type { StateRepository } from '../persistence/state-repository';
import type { SystemCapabilityCatalog } from '../services/system-capabilities';
import type { TerminalSessionService } from '../services/terminal-service';
import type { WorkspaceFileService } from '../services/workspace-file-service';
import type { MainWindowController } from '../windows/main-window';
import { RuntimeRequestError, type RuntimeSupervisor } from '../runtime/runtime-supervisor';
import type { SpeechPort } from '../speech/entity/speech-port';
import type { ActivateSpeechVoiceRequest, SpeechVoiceSummary } from '@shared/contract';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';
import { backupCreatedViewSchema, dataRestorePreviewSchema, dataRestoreTicketSchema, dataUsageViewSchema,
  sessionTextExportRequestSchema, sessionTextExportResultSchema, dataCleanupPreviewSchema, dataCleanupCommitSchema,
  dataCleanupResultSchema } from '@shared/data-management';
import type { AriadneApi } from '@shared/contract';

const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

interface IpcDependencies {
  dataManagement: AriadneApi['dataManagement'];
  writeAdmission?: MainWriteAdmission;
  fileDrafts: FileDraftRepository;
  chatDrafts: ChatDraftRepository;
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
  inputDeliveryOutbox: InputDeliveryOutbox;
  speech: SpeechPort;
  getApplicationProfile(): ApplicationProfileView;
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
  const handleWrite = (channel: string, handle: (event: IpcMainInvokeEvent, input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => {
      trusted(event);
      return (dependencies.writeAdmission ?? unrestrictedMainWrites).write(() => handle(event, input));
    });
  };
  // Each operation owns its lifecycle boundary. Holding a write-admission
  // ticket while asking it to drain would wait on the operation itself.
  ipcMain.handle(IPC_CHANNELS.dataCleanupInspect, async (event, input: unknown) => {
    trusted(event); if (input !== undefined) throw new Error('data_request_invalid');
    try { return dataCleanupPreviewSchema.parse(await dependencies.dataManagement.inspectCleanup()); }
    catch { throw new Error('data_cleanup_preview_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataCleanupCommit, async (event, input: unknown) => {
    trusted(event); const request = dataCleanupCommitSchema.parse(input);
    try { return dataCleanupResultSchema.parse(await dependencies.dataManagement.commitCleanup(request)); }
    catch { throw new Error('data_cleanup_not_settled'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataCleanupDiscard, async (event, input: unknown) => {
    trusted(event); const request = dataRestoreTicketSchema.parse(input);
    try { await dependencies.dataManagement.discardCleanup(request); }
    catch { throw new Error('data_cleanup_preview_release_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataSessionExport, async (event, input: unknown) => {
    trusted(event); const request = sessionTextExportRequestSchema.parse(input);
    try { const result = await dependencies.dataManagement.exportSession(request); return result ? sessionTextExportResultSchema.parse(result) : null; }
    catch { throw new Error('data_session_export_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataUsageMeasure, async (event, input: unknown) => {
    trusted(event); if (input !== undefined) throw new Error('data_request_invalid');
    try { return dataUsageViewSchema.parse(await dependencies.dataManagement.measureUsage()); }
    catch { throw new Error('data_usage_measurement_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataBackupCreate, async (event, input: unknown) => {
    trusted(event); if (input !== undefined) throw new Error('data_request_invalid');
    try { const result = await dependencies.dataManagement.createBackup(); return result ? backupCreatedViewSchema.parse(result) : null; }
    catch { throw new Error('data_backup_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataRestoreInspect, async (event, input: unknown) => {
    trusted(event); if (input !== undefined) throw new Error('data_request_invalid');
    try { const result = await dependencies.dataManagement.inspectRestore(); return result ? dataRestorePreviewSchema.parse(result) : null; }
    catch { throw new Error('data_restore_validation_failed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataRestoreCommit, async (event, input: unknown) => {
    trusted(event); const request = dataRestoreTicketSchema.parse(input);
    try { await dependencies.dataManagement.commitRestore(request); }
    catch { throw new Error('data_restore_not_committed'); }
  });
  ipcMain.handle(IPC_CHANNELS.dataRestoreDiscard, async (event, input: unknown) => {
    trusted(event); const request = dataRestoreTicketSchema.parse(input);
    try { await dependencies.dataManagement.discardRestore(request); }
    catch { throw new Error('data_restore_preview_release_failed'); }
  });
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

  handleWrite(IPC_CHANNELS.agentSettingsApply, async (event, input: unknown) => {
    trusted(event);
    return dependencies.applyAgentSettings(agentSettingsMutationSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.agentWorkspacePinUpdate, async (event, input: unknown) => {
    trusted(event);
    return dependencies.setWorkspacePinned(agentWorkspacePinUpdateSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.agentWorkspaceArchive, async (event, input: unknown) => {
    trusted(event);
    return dependencies.archiveWorkspace(agentWorkspaceRequestSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.agentWorkspaceRestore, async (event, input: unknown) => {
    trusted(event);
    return dependencies.restoreWorkspace(agentWorkspaceRequestSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.systemApprovalNotificationTest, (event) => {
    trusted(event);
    return dependencies.testApprovalNotification();
  });

  ipcMain.handle(IPC_CHANNELS.systemApplicationProfile, (event) => {
    trusted(event);
    return dependencies.getApplicationProfile();
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

  handleWrite(IPC_CHANNELS.layoutSave, async (event, input: unknown) => {
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

  handleWrite(IPC_CHANNELS.preferencesUpdate, async (event, input: unknown) => {
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
      return await (dependencies.writeAdmission ?? unrestrictedMainWrites).write(async () => ({
        ok: true,
        value: await dependencies.runtime.request(
          request.command,
          request.commandId ? { commandId: request.commandId } : {}
        )
      }));
    } catch (error) {
      return runtimeIpcFailure(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.fileDraftList, event => { trusted(event); return dependencies.fileDrafts.list(); });
  const resolveFileDraftPath = async (input:unknown) => {
    const request=fileDraftPathRequestSchema.parse(input),resolved=await dependencies.workspaceFiles.resolveDocumentPath(request);
    if(!resolved.exists){
      const catalog=await dependencies.fileDrafts.list();
      for(const row of catalog.records)if(row.workspaceId===request.workspaceId&&!row.exists){
        const other=await dependencies.workspaceFiles.resolveDocumentPath({workspaceId:row.workspaceId,path:row.path});
        if(!other.exists&&other.comparisonPath===resolved.comparisonPath)return {...resolved,path:row.path};
      }
    }
    return resolved;
  };
  ipcMain.handle(IPC_CHANNELS.fileDraftResolvePath, async(event,input:unknown)=>{trusted(event);return resolveFileDraftPath(input);});
  handleWrite(IPC_CHANNELS.fileDraftReplace, async (event, input: unknown) => {
    trusted(event); const request = fileDraftReplaceSchema.parse(input), previous = await dependencies.fileDrafts.list();
    for (const row of request.records) if (!previous.records.some(old => old.draftId === row.draftId && old.workspaceId === row.workspaceId && old.path === row.path)) {
      if((await resolveFileDraftPath({workspaceId:row.workspaceId,path:row.path})).path!==row.path)throw new Error('file_draft_path_not_canonical');
    }
    // Two new rows in the same replacement must not bypass the catalog CAS.
    const newIdentities=new Set<string>();
    for(const row of request.records)if(!row.exists){
      let resolved;
      try{resolved=await dependencies.workspaceFiles.resolveDocumentPath({workspaceId:row.workspaceId,path:row.path});}
      catch(error){if(previous.records.some(old=>old.draftId===row.draftId&&old.workspaceId===row.workspaceId&&old.path===row.path))continue;throw error;}
      const key=JSON.stringify([row.workspaceId,resolved.exists?'existing':'new',resolved.comparisonPath]);
      if(newIdentities.has(key))throw new Error('file_draft_path_alias_conflict');newIdentities.add(key);
    }
    return dependencies.fileDrafts.replace(request);
  });
  ipcMain.handle(IPC_CHANNELS.chatDraftList, event => { trusted(event); return dependencies.chatDrafts.list(); });
  handleWrite(IPC_CHANNELS.chatDraftWrite, async (event, input: unknown) => {
    trusted(event); return dependencies.chatDrafts.write(chatDraftWriteSchema.parse(input));
  });
  handleWrite(IPC_CHANNELS.chatDraftMove, async (event, input: unknown) => {
    trusted(event); return dependencies.chatDrafts.move(chatDraftMoveSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.chatDraftReadAttachment, (event, input: unknown) => {
    trusted(event); return dependencies.chatDrafts.readAttachment(chatDraftAttachmentReadSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.inputDeliveryOutboxList, async (event) => {
    trusted(event);
    await dependencies.inputDeliveryOutbox.flush();
    return dependencies.inputDeliveryOutbox.list();
  });

  handleWrite(IPC_CHANNELS.inputDeliveryOutboxStageBatch, async (event, input: unknown) => {
    trusted(event); return dependencies.inputDeliveryOutbox.stageBatch(parseInputDeliveryOutboxBatch(input));
  });

  handleWrite(IPC_CHANNELS.inputDeliveryOutboxStage, async (event, input: unknown) => {
    trusted(event);
    return dependencies.inputDeliveryOutbox.stage(
      parseInputDeliveryOutboxStageRequest(input)
    );
  });

  handleWrite(IPC_CHANNELS.inputDeliveryOutboxSettle, async (event, input: unknown) => {
    trusted(event);
    const request = inputDeliveryOutboxSettleRequestSchema.parse(input);
    await dependencies.inputDeliveryOutbox.settle(request.commandId);
  });

  ipcMain.handle(IPC_CHANNELS.speechStatus, (event) => {
    trusted(event);
    return dependencies.speech.getStatus();
  });

  handleWrite(IPC_CHANNELS.speechStartRecognition, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.startRecognition(startSpeechRecognitionRequestSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.speechStopRecognition, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.stopRecognition(stopSpeechRecognitionRequestSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.speechCancelRecognition, async (event) => {
    trusted(event);
    await dependencies.speech.cancelRecognition();
  });

  handleWrite(IPC_CHANNELS.speechSynthesize, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.synthesize(speechSynthesisSegmentRequestSchema.parse(input));
  });

  handleWrite(IPC_CHANNELS.speechCancelSynthesis, async (event, input: unknown) => {
    trusted(event);
    await dependencies.speech.cancelSynthesis(cancelSpeechSynthesisRequestSchema.parse(input ?? {}));
  });

  handleWrite(IPC_CHANNELS.speechVoicePackImport, async (event) => {
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

  handleWrite(IPC_CHANNELS.speechVoiceActivate, async (event, input: unknown) => {
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

  handleWrite(IPC_CHANNELS.workspaceOpenDirectory, async (event) => {
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

  handleWrite(IPC_CHANNELS.terminalCreate, (event, input: unknown) => {
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
      const request = schema.parse(input);
      void (dependencies.writeAdmission ?? unrestrictedMainWrites).write(() => handle(event, request)).catch((error) => {
        console.error('Rejected terminal IPC request.', error);
      });
    } catch (error) {
      console.error('Rejected terminal IPC request.', error);
    }
  };
}
