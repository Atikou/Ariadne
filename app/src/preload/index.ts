import { contextBridge, ipcRenderer } from 'electron';
import type { AriadneApi, TerminalDataEvent, TerminalExitEvent } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';

const api: AriadneApi = {
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
  system: {
    getCapabilityStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.systemCapabilityStatuses),
    getGameActivity: () => ipcRenderer.invoke(IPC_CHANNELS.systemGameActivity)
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
