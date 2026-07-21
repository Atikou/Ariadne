import { clipboard, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { Buffer } from 'node:buffer';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  clipboardWriteRequestSchema,
  closeTerminalRequestSchema,
  createTerminalSessionRequestSchema,
  resizeTerminalRequestSchema,
  saveLayoutRequestSchema,
  showWindowRequestSchema,
  titleBarThemeSchema,
  userPreferencesSchema,
  workspaceDirectoryRequestSchema,
  writeTerminalRequestSchema
} from '@shared/schemas';
import type { StateRepository } from '../persistence/state-repository';
import type { SystemCapabilityCatalog } from '../services/system-capabilities';
import type { TerminalSessionService } from '../services/terminal-service';
import type { WorkspaceFileService } from '../services/workspace-file-service';
import type { MainWindowController } from '../windows/main-window';

const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

interface IpcDependencies {
  getWindow(): BrowserWindow | null;
  state: StateRepository;
  systemCapabilities: SystemCapabilityCatalog;
  terminals: TerminalSessionService;
  mainWindow: MainWindowController;
  workspaceFiles: WorkspaceFileService;
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const channels: string[] = Object.values(IPC_CHANNELS);
  const trusted = (event: IpcMainInvokeEvent): void => assertTrustedSender(event, dependencies.getWindow());
  const terminalWriteListener = createValidatedTerminalListener(dependencies, writeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.write(event.sender.id, request);
  });
  const terminalResizeListener = createValidatedTerminalListener(dependencies, resizeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.resize(event.sender.id, request);
  });
  const terminalCloseListener = createValidatedTerminalListener(dependencies, closeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.close(event.sender.id, request.sessionId);
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
    const next = userPreferencesSchema.parse(input);
    const previous = dependencies.state.getPreferences();
    await dependencies.systemCapabilities.applyPreferences(previous, next);
    await dependencies.state.savePreferences(next);
    return dependencies.state.getPreferences();
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

  ipcMain.handle(IPC_CHANNELS.terminalCreate, (event, input: unknown) => {
    trusted(event);
    return dependencies.terminals.create(event.sender, createTerminalSessionRequestSchema.parse(input));
  });
  ipcMain.on(IPC_CHANNELS.terminalWrite, terminalWriteListener);
  ipcMain.on(IPC_CHANNELS.terminalResize, terminalResizeListener);
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
    dependencies.getWindow()?.setTitleBarOverlay({
      color: theme === 'dark' ? '#111318' : '#f4f5f7',
      symbolColor: theme === 'dark' ? '#d9dde7' : '#252832',
      height: 44
    });
  });

  return () => {
    ipcMain.removeListener(IPC_CHANNELS.terminalWrite, terminalWriteListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalResize, terminalResizeListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalClose, terminalCloseListener);
    const renderer = dependencies.getWindow()?.webContents;
    if (renderer) dependencies.terminals.closeOwnedBy(renderer.id);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Rejected IPC from an untrusted sender.');
  }
}

function createValidatedTerminalListener<T>(
  dependencies: IpcDependencies,
  schema: { parse(input: unknown): T },
  handle: (event: IpcMainEvent, request: T) => void
): (event: IpcMainEvent, input: unknown) => void {
  return (event, input) => {
    try {
      assertTrustedSender(event, dependencies.getWindow());
      handle(event, schema.parse(input));
    } catch (error) {
      console.error('Rejected terminal IPC request.', error);
    }
  };
}
