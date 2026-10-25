import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import type { AriadneApi, SpeechEvent, TerminalExitEvent, TerminalOutputEvent } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { notificationNavigationRequestSchema } from '@shared/task-notification';
import {
  runtimeRequestResultSchema,
  runtimeStatusResultSchema,
  parseInputDeliveryOutboxRecords,
  parseInputDeliveryOutboxStageRequest,
  parseInputDeliveryOutboxBatch
} from '@shared/schemas';
import { runtimeStatusSchema } from '@ariadne/protocol/public';
import { encodedImageAttachmentSchema } from '@ariadne/protocol/public';
import { chatDraftAttachmentReadSchema, chatDraftCatalogSchema, chatDraftMoveSchema, chatDraftRecordSchema,
  chatDraftWriteSchema } from '@shared/chat-drafts';
import { fileDraftCatalogSchema, fileDraftReplaceSchema, fileDraftPathRequestSchema, fileDraftPathResultSchema } from '@shared/file-drafts';
import { backupCreatedViewSchema, dataRestorePreviewSchema, dataRestoreTicketSchema, dataUsageViewSchema,
  sessionTextExportRequestSchema, sessionTextExportResultSchema, dataCleanupPreviewSchema, dataCleanupCommitSchema,
  dataCleanupResultSchema } from '@shared/data-management';

const api: AriadneApi = {
  dataManagement: {
    inspectCleanup: async () => dataCleanupPreviewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.dataCleanupInspect)),
    commitCleanup: async request => dataCleanupResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.dataCleanupCommit, dataCleanupCommitSchema.parse(request))),
    discardCleanup: request => ipcRenderer.invoke(IPC_CHANNELS.dataCleanupDiscard, dataRestoreTicketSchema.parse(request)),
    exportSession: async request => { const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.dataSessionExport, sessionTextExportRequestSchema.parse(request));
      return result === null ? null : sessionTextExportResultSchema.parse(result); },
    measureUsage: async () => dataUsageViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.dataUsageMeasure)),
    createBackup: async () => { const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.dataBackupCreate);
      return result === null ? null : backupCreatedViewSchema.parse(result); },
    inspectRestore: async () => { const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.dataRestoreInspect);
      return result === null ? null : dataRestorePreviewSchema.parse(result); },
    commitRestore: request => ipcRenderer.invoke(IPC_CHANNELS.dataRestoreCommit, dataRestoreTicketSchema.parse(request)),
    discardRestore: request => ipcRenderer.invoke(IPC_CHANNELS.dataRestoreDiscard, dataRestoreTicketSchema.parse(request))
  },
  fileDrafts: {
    resolvePath: async request => fileDraftPathResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.fileDraftResolvePath,fileDraftPathRequestSchema.parse(request))),
    list: async () => fileDraftCatalogSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.fileDraftList)),
    replace: async request => fileDraftCatalogSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.fileDraftReplace, fileDraftReplaceSchema.parse(request)))
  },
  chatDrafts: {
    list: async () => chatDraftCatalogSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.chatDraftList)),
    write: async request => chatDraftRecordSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.chatDraftWrite, chatDraftWriteSchema.parse(request))),
    move: async request => chatDraftRecordSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.chatDraftMove, chatDraftMoveSchema.parse(request))),
    readAttachment: async request => encodedImageAttachmentSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.chatDraftReadAttachment,
      chatDraftAttachmentReadSchema.parse(request)))
  },
  agentSettings: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.agentSettingsLoad),
    apply: (mutation) => ipcRenderer.invoke(IPC_CHANNELS.agentSettingsApply, mutation),
    setWorkspacePinned: (request) => ipcRenderer.invoke(IPC_CHANNELS.agentWorkspacePinUpdate, request),
    archiveWorkspace: (request) => ipcRenderer.invoke(IPC_CHANNELS.agentWorkspaceArchive, request),
    restoreWorkspace: (request) => ipcRenderer.invoke(IPC_CHANNELS.agentWorkspaceRestore, request),
    onWorkspacesChanged: (listener) => subscribe(IPC_CHANNELS.agentWorkspacesChanged, listener)
  },
  clipboard: {
    writeText: (request) => ipcRenderer.invoke(IPC_CHANNELS.clipboardWrite, request)
  },
  layout: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.layoutLoad),
    save: (request) => ipcRenderer.invoke(IPC_CHANNELS.layoutSave, request)
  },
  preferences: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesLoad),
    update: (preferences) => ipcRenderer.invoke(IPC_CHANNELS.preferencesUpdate, preferences)
  },
  runtime: {
    getStatus: async () => runtimeStatusResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.runtimeStatus)
    ),
    onStatus: (listener) => subscribe<unknown>(
      IPC_CHANNELS.runtimeStatusChanged,
      (status) => listener(runtimeStatusSchema.parse(status))
    ),
    request: async (command, options) => runtimeRequestResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.runtimeRequest, {
        command,
        ...(options?.commandId ? { commandId: options.commandId } : {})
      })
    ),
    onEvent: (listener) => subscribe<RuntimeEventEnvelope>(IPC_CHANNELS.runtimeEvent, listener)
  },
  inputDeliveryOutbox: {
    stageBatch: async requests => parseInputDeliveryOutboxRecords(await ipcRenderer.invoke(
      IPC_CHANNELS.inputDeliveryOutboxStageBatch, parseInputDeliveryOutboxBatch(requests))),
    list: async () => parseInputDeliveryOutboxRecords(
      await ipcRenderer.invoke(IPC_CHANNELS.inputDeliveryOutboxList)
    ),
    stage: async (request) => {
      const parsed = parseInputDeliveryOutboxStageRequest(request);
      const records = parseInputDeliveryOutboxRecords([
        await ipcRenderer.invoke(IPC_CHANNELS.inputDeliveryOutboxStage, parsed)
      ]);
      return records[0]!;
    },
    settle: (request) => ipcRenderer.invoke(
      IPC_CHANNELS.inputDeliveryOutboxSettle,
      request
    )
  },
  speech: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.speechStatus),
    startRecognition: (request) => ipcRenderer.invoke(IPC_CHANNELS.speechStartRecognition, request),
    stopRecognition: (request) => ipcRenderer.invoke(IPC_CHANNELS.speechStopRecognition, request),
    cancelRecognition: () => ipcRenderer.invoke(IPC_CHANNELS.speechCancelRecognition),
    synthesize: (request) => ipcRenderer.invoke(IPC_CHANNELS.speechSynthesize, request),
    cancelSynthesis: (request) => ipcRenderer.invoke(IPC_CHANNELS.speechCancelSynthesis, request ?? {}),
    importVoicePack: () => ipcRenderer.invoke(IPC_CHANNELS.speechVoicePackImport),
    activateVoice: (request) => ipcRenderer.invoke(IPC_CHANNELS.speechVoiceActivate, request),
    onEvent: (listener) => subscribe<SpeechEvent>(IPC_CHANNELS.speechEvent, listener)
  },
  system: {
    getApplicationProfile: () => ipcRenderer.invoke(IPC_CHANNELS.systemApplicationProfile),
    getCapabilityStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.systemCapabilityStatuses),
    getGameActivity: () => ipcRenderer.invoke(IPC_CHANNELS.systemGameActivity),
    testApprovalNotification: () => ipcRenderer.invoke(IPC_CHANNELS.systemApprovalNotificationTest),
    onApprovalNavigation: (listener) =>
      subscribe(IPC_CHANNELS.systemApprovalNavigation, (value) => {
        const result = notificationNavigationRequestSchema.safeParse(value);
        if (result.success) listener({ sessionId: result.data.sessionId,
          ...(result.data.decisionId === undefined ? {} : { decisionId: result.data.decisionId }),
          ...(result.data.taskNavigation === undefined ? {} : { taskNavigation: result.data.taskNavigation }) });
      })
  },
  terminal: {
    listRecoveryRecords: () => ipcRenderer.invoke(IPC_CHANNELS.terminalRecoveryList),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, request),
    write: (request) => ipcRenderer.send(IPC_CHANNELS.terminalWrite, request),
    resize: (request) => ipcRenderer.send(IPC_CHANNELS.terminalResize, request),
    signal: (request) => ipcRenderer.send(IPC_CHANNELS.terminalSignal, request),
    close: (request) => ipcRenderer.send(IPC_CHANNELS.terminalClose, request),
    onOutput: (listener) => subscribe<TerminalOutputEvent>(IPC_CHANNELS.terminalOutput, listener),
    onExit: (listener) => subscribe<TerminalExitEvent>(IPC_CHANNELS.terminalExit, listener)
  },
  workspace: {
    openDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenDirectory),
    listDirectory: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceListDirectory, request)
  },
  window: {
    hide: () => ipcRenderer.invoke(IPC_CHANNELS.windowHide),
    show: (request) => ipcRenderer.invoke(IPC_CHANNELS.windowShow, request),
    setTitleBarTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.windowTitleBarTheme, theme)
  }
};

contextBridge.exposeInMainWorld('ariadne', Object.freeze(api));

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
