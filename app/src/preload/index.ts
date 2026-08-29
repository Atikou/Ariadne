import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import type { AriadneApi, SpeechEvent, TerminalExitEvent, TerminalOutputEvent } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  runtimeRequestResultSchema,
  runtimeStatusResultSchema,
  parseAgentInputDeliveryOutboxRecords,
  parseAgentInputDeliveryOutboxStageRequest
} from '@shared/schemas';
import { runtimeStatusSchema } from '@ariadne/protocol/public';

const api: AriadneApi = {
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
  agentInputDeliveryOutbox: {
    list: async () => parseAgentInputDeliveryOutboxRecords(
      await ipcRenderer.invoke(IPC_CHANNELS.agentInputDeliveryOutboxList)
    ),
    stage: async (request) => {
      const parsed = parseAgentInputDeliveryOutboxStageRequest(request);
      const records = parseAgentInputDeliveryOutboxRecords([
        await ipcRenderer.invoke(IPC_CHANNELS.agentInputDeliveryOutboxStage, parsed)
      ]);
      return records[0]!;
    },
    settle: (request) => ipcRenderer.invoke(
      IPC_CHANNELS.agentInputDeliveryOutboxSettle,
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
    getCapabilityStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.systemCapabilityStatuses),
    getGameActivity: () => ipcRenderer.invoke(IPC_CHANNELS.systemGameActivity),
    testApprovalNotification: () => ipcRenderer.invoke(IPC_CHANNELS.systemApprovalNotificationTest),
    onApprovalNavigation: (listener) =>
      subscribe(IPC_CHANNELS.systemApprovalNavigation, listener)
  },
  terminal: {
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, request),
    write: (request) => ipcRenderer.send(IPC_CHANNELS.terminalWrite, request),
    resize: (request) => ipcRenderer.send(IPC_CHANNELS.terminalResize, request),
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
