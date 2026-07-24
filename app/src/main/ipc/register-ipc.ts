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
import { runtimeCommandSchema, runtimeEventEnvelopeSchema } from '@ariadne/protocol/public';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  agentSettingsUpdateSchema,
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
import type { AgentSettingsUpdate, AgentSettingsView, OpenWorkspaceResult, UserPreferences } from '@shared/contract';
import type { AgentSettingsRepository } from '../persistence/agent-settings-repository';
import type { StateRepository } from '../persistence/state-repository';
import type { SystemCapabilityCatalog } from '../services/system-capabilities';
import type { TerminalSessionService } from '../services/terminal-service';
import type { WorkspaceFileService } from '../services/workspace-file-service';
import type { MainWindowController } from '../windows/main-window';
import type { RuntimeSupervisor } from '../runtime/runtime-supervisor';

const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

interface IpcDependencies {
  getWindow(): BrowserWindow | null;
  agentSettings: AgentSettingsRepository;
  updateAgentSettings(settings: AgentSettingsUpdate): Promise<AgentSettingsView>;
  updatePreferences(preferences: UserPreferences): Promise<UserPreferences>;
  addWorkspaceRoot(rootPath: string): Promise<OpenWorkspaceResult>;
  state: StateRepository;
  systemCapabilities: SystemCapabilityCatalog;
  terminals: TerminalSessionService;
  mainWindow: MainWindowController;
  runtime: RuntimeSupervisor;
  workspaceFiles: WorkspaceFileService;
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const channels: string[] = Object.values(IPC_CHANNELS);
  const trusted = (event: IpcMainInvokeEvent): void => assertTrustedSender(
    event,
    dependencies.mainWindow.getPrivilegedRendererContents()
  );
  const terminalWriteListener = createValidatedTerminalListener(dependencies, writeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.write(event.sender.id, request);
  });
  const terminalResizeListener = createValidatedTerminalListener(dependencies, resizeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.resize(event.sender.id, request);
  });
  const terminalCloseListener = createValidatedTerminalListener(dependencies, closeTerminalRequestSchema, (event, request) => {
    dependencies.terminals.close(event.sender.id, request.sessionId);
  });
  const removeRuntimeEvents = dependencies.runtime.onEvent((event) => {
    const parsed = runtimeEventEnvelopeSchema.parse(event);
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      renderer.send(IPC_CHANNELS.runtimeEvent, parsed);
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentSettingsLoad, (event) => {
    trusted(event);
    return dependencies.agentSettings.getView();
  });

  ipcMain.handle(IPC_CHANNELS.agentSettingsUpdate, async (event, input: unknown) => {
    trusted(event);
    return dependencies.updateAgentSettings(agentSettingsUpdateSchema.parse(input));
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
    trusted(event);
    return dependencies.runtime.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.runtimeRequest, async (event, input: unknown) => {
    trusted(event);
    return dependencies.runtime.request(runtimeCommandSchema.parse(input));
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
    nativeTheme.themeSource = theme;
    const window = dependencies.getWindow();
    const backgroundColor = theme === 'dark' ? '#0d0f13' : '#eceef2';
    window?.setBackgroundColor(backgroundColor);
    window?.setTitleBarOverlay({
      color: theme === 'dark' ? '#111318' : '#f4f5f7',
      symbolColor: theme === 'dark' ? '#d9dde7' : '#252832',
      height: 44
    });
    for (const child of dependencies.mainWindow.getPopoutWindows()) child.setBackgroundColor(backgroundColor);
  });

  return () => {
    removeRuntimeEvents();
    ipcMain.removeListener(IPC_CHANNELS.terminalWrite, terminalWriteListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalResize, terminalResizeListener);
    ipcMain.removeListener(IPC_CHANNELS.terminalClose, terminalCloseListener);
    for (const renderer of dependencies.mainWindow.getPrivilegedRendererContents()) {
      dependencies.terminals.closeOwnedBy(renderer.id);
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

function createValidatedTerminalListener<T>(
  dependencies: IpcDependencies,
  schema: { parse(input: unknown): T },
  handle: (event: IpcMainEvent, request: T) => void
): (event: IpcMainEvent, input: unknown) => void {
  return (event, input) => {
    try {
      assertTrustedSender(event, dependencies.mainWindow.getPrivilegedRendererContents());
      handle(event, schema.parse(input));
    } catch (error) {
      console.error('Rejected terminal IPC request.', error);
    }
  };
}
