import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import type { AriadneApi, TerminalDataEvent, TerminalExitEvent } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';

const api: AriadneApi = {
  agentSettings: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.agentSettingsLoad),
    update: (settings) => ipcRenderer.invoke(IPC_CHANNELS.agentSettingsUpdate, settings),
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
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeStatus),
    request: (command) => ipcRenderer.invoke(IPC_CHANNELS.runtimeRequest, command),
    onEvent: (listener) => subscribe<RuntimeEventEnvelope>(IPC_CHANNELS.runtimeEvent, listener)
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
    onData: (listener) => subscribe<TerminalDataEvent>(IPC_CHANNELS.terminalData, listener),
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
