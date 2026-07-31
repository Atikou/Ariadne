import { app, Menu, Notification, shell, Tray } from 'electron';
import { join } from 'node:path';
import type { RuntimeCapabilityRequest } from '@ariadne/protocol/host';
import type {
  AgentSettingsUpdate,
  AgentSettingsView,
  AgentWorkspacePinUpdate,
  AgentWorkspaceRequest,
  OpenWorkspaceResult
} from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { AgentSettingsRepository } from './persistence/agent-settings-repository';
import { McpOAuthCredentialVault } from './persistence/mcp-oauth-credential-vault';
import { ElectronSafeStorageCipher } from './persistence/secret-cipher';
import { StateRepository } from './persistence/state-repository';
import { registerIpcHandlers } from './ipc/register-ipc';
import {
  ElectronAutoLaunchService,
  SystemCapabilityCatalog,
  UnavailableGameActivityDetector
} from './services/system-capabilities';
import { InterruptionPolicy } from './services/interruption-policy';
import { TerminalSessionService } from './services/terminal-service';
import { WorkspaceFileService } from './services/workspace-file-service';
import { ApprovalNotificationService } from './services/approval-notification-service';
import { BrowserService } from './services/browser-service';
import { McpRemoteService } from './runtime/mcp-remote-service';
import { PreferencesCoordinator } from './services/preferences-coordinator';
import { MainWindowController } from './windows/main-window';
import { RendererSource } from './windows/renderer-source';
import { createDesktopRuntimeConfiguration, resolveDefaultWorkspaceRoot } from './runtime/runtime-configuration';
import { RuntimeSupervisor } from './runtime/runtime-supervisor';
import { runElectronSmokeTest } from './smoke/electron-smoke';

export class ApplicationController {
  private isQuitting = false;
  private cleanupPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private agentSettingsOperationQueue: Promise<void> = Promise.resolve();
  private workspaceArchiveCleanupTimer: NodeJS.Timeout | null = null;
  private tray: Tray | null = null;
  private removeIpcHandlers: (() => void) | null = null;
  private removeApprovalNotificationEvents: (() => void) | null = null;
  private readonly state = new StateRepository(join(app.getPath('userData'), 'state.json'));
  private readonly defaultWorkspaceRoot = resolveDefaultWorkspaceRoot({
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged
  });
  private readonly secretCipher = new ElectronSafeStorageCipher();
  private readonly agentSettings = new AgentSettingsRepository(
    join(app.getPath('userData'), 'settings.toml'),
    this.secretCipher,
    this.defaultWorkspaceRoot,
    join(app.getPath('userData'), 'agent-settings.json')
  );
  private readonly mcpOAuthVault = new McpOAuthCredentialVault(
    join(app.getPath('userData'), 'mcp-oauth-vault.json'),
    this.secretCipher
  );
  private readonly mcpRemote = new McpRemoteService(
    this.mcpOAuthVault,
    async (url) => {
      await shell.openExternal(url);
    }
  );
  private readonly gameActivity = new UnavailableGameActivityDetector();
  private readonly interruptionPolicy = new InterruptionPolicy();
  private readonly systemCapabilities = new SystemCapabilityCatalog(
    new ElectronAutoLaunchService(),
    this.gameActivity
  );
  private readonly preferences = new PreferencesCoordinator(this.state, this.systemCapabilities);
  private readonly workspaceFiles = new WorkspaceFileService([{
    workspaceId: 'primary',
    rootPath: this.defaultWorkspaceRoot
  }]);
  private readonly terminals = new TerminalSessionService((workspaceId) => (
    this.workspaceFiles.getRoot(workspaceId)
  ));
  private readonly browser = new BrowserService({
    audit: (event) => {
      console.info('[browser-audit]', JSON.stringify(event));
    }
  });
  private readonly runtime = new RuntimeSupervisor(this.createRuntimeConfiguration());
  private readonly rendererSource = new RendererSource(join(__dirname, '../renderer'), {
    allowDevelopmentServer: !app.isPackaged
  });
  private readonly mainWindow = new MainWindowController(
    this.state,
    this.gameActivity,
    this.interruptionPolicy,
    () => this.isQuitting,
    () => this.requestQuit()
  );
  private readonly approvalNotifications = new ApprovalNotificationService({
    isSupported: () => Notification.isSupported(),
    isWindowFocused: () => this.mainWindow.isApplicationFocused(),
    canNotify: async () => this.interruptionPolicy.evaluate(
      { source: 'system', allowTemporaryTopmost: false },
      await this.gameActivity.getSnapshot(),
      this.state.getPreferences()
    ).allow,
    create: (content) => {
      const notification = new Notification(content);
      return {
        onClick: (handler) => notification.once('click', handler),
        show: () => notification.show(),
        close: () => notification.close()
      };
    },
    activateApplication: (sessionId) => {
      this.showFromUserActionSafely();
      if (sessionId) {
        this.mainWindow.get()?.webContents.send(
          IPC_CHANNELS.systemApprovalNavigation,
          { sessionId }
        );
      }
    }
  });

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startApplication();
    }
    await this.startPromise;
  }

  async showFromUserAction(): Promise<void> {
    await app.whenReady();
    await this.start();
    await this.mainWindow.show({ source: 'user', allowTemporaryTopmost: false });
  }

  async runSmokeTest(outputRoot: string): Promise<boolean> {
    const window = this.mainWindow.get();
    if (!window) throw new Error('Main window is unavailable for smoke verification.');
    return runElectronSmokeTest(window, outputRoot);
  }

  async handleOpenUrl(rawUrl: string): Promise<boolean> {
    await this.mcpOAuthVault.initialize();
    return this.mcpRemote.handleOAuthCallback(rawUrl);
  }

  async prepareToQuit(): Promise<void> {
    this.isQuitting = true;
    if (!this.cleanupPromise) {
      this.cleanupPromise = (async () => {
        await this.agentSettingsOperationQueue;
        await this.preferences.flush();
        await this.mainWindow.saveWindowStateNow();
        await this.state.flush();
        await this.agentSettings.flush();
        if (this.workspaceArchiveCleanupTimer) clearTimeout(this.workspaceArchiveCleanupTimer);
        this.workspaceArchiveCleanupTimer = null;
        this.removeIpcHandlers?.();
        this.removeIpcHandlers = null;
        this.removeApprovalNotificationEvents?.();
        this.removeApprovalNotificationEvents = null;
        this.approvalNotifications.dispose();
        await this.runtime.stop('app_quit');
        await this.mcpRemote.dispose();
        await this.mcpOAuthVault.flush();
        this.browser.dispose();
        this.rendererSource.stop();
        this.terminals.dispose();
        this.tray?.destroy();
        this.tray = null;
      })();
    }
    await this.cleanupPromise;
  }

  private async startApplication(): Promise<void> {
    await Promise.all([
      this.state.initialize(),
      this.agentSettings.initialize(),
      this.mcpOAuthVault.initialize()
    ]);
    const initialRuntimeSettings = this.agentSettings.getRuntimeSettings();
    this.workspaceFiles.setWorkspaces(initialRuntimeSettings.workspaces);
    this.browser.configure(
      initialRuntimeSettings.runtimePolicy.browser,
      initialRuntimeSettings.workspaces[0]?.workspaceId ?? 'primary'
    );
    await this.mcpRemote.configure(initialRuntimeSettings.runtimePolicy.mcp.servers);
    this.runtime.configure(this.createRuntimeConfiguration());
    const rendererUrl = this.rendererSource.start();
    const window = this.mainWindow.create(rendererUrl);
    this.removeIpcHandlers = registerIpcHandlers({
      getWindow: () => this.mainWindow.get(),
      agentSettings: this.agentSettings,
      updateAgentSettings: (settings) => this.updateAgentSettings(settings),
      setWorkspacePinned: (request) => this.setWorkspacePinned(request),
      archiveWorkspace: (request) => this.archiveWorkspace(request),
      restoreWorkspace: (request) => this.restoreWorkspace(request),
      updatePreferences: (preferences) => this.preferences.update(preferences),
      addWorkspaceRoot: (rootPath) => this.addWorkspaceRoot(rootPath),
      state: this.state,
      systemCapabilities: this.systemCapabilities,
      terminals: this.terminals,
      workspaceFiles: this.workspaceFiles,
      runtime: this.runtime,
      mainWindow: this.mainWindow,
      testApprovalNotification: () => this.approvalNotifications.showTestNotification()
    });
    this.removeApprovalNotificationEvents = this.runtime.onEvent((event) => {
      void this.approvalNotifications.handleRuntimeEvent(event.event).catch((error: unknown) => {
        console.error('Approval notification event handling failed.', error);
      });
    });
    await this.mainWindow.waitUntilRendererLoaded();
    void this.runtime.start()
      .then(() => this.cleanupDueArchivedWorkspaces())
      .catch(() => {
        console.error('Runtime was unavailable during application startup.');
        this.scheduleArchivedWorkspaceCleanup(60_000);
      });
    this.tray = await this.createTray();
    window.on('show', () => this.updateTrayMenu());
    window.on('hide', () => this.updateTrayMenu());
  }

  private createRuntimeConfiguration() {
    return {
      ...createDesktopRuntimeConfiguration({
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      executablePath: process.execPath,
      agentSettings: this.agentSettings.getRuntimeSettings()
      }),
      capabilityHandler: async (request: RuntimeCapabilityRequest) => {
        if (request.capability === 'browser') return this.browser.handle(request.operation);
        if (request.capability === 'mcp_remote') return this.mcpRemote.handle(request.operation);
        throw new Error('host_capability_unknown');
      }
    };
  }

  private async updateAgentSettings(settings: AgentSettingsUpdate): Promise<AgentSettingsView> {
    return this.runAgentSettingsOperation(async () => {
      const checkpoint = this.agentSettings.createCheckpoint();
      const saved = await this.agentSettings.save(settings);
      try {
        await this.applyAgentSettings(saved);
        return saved;
      } catch (error) {
        return this.rollbackAgentSettings(checkpoint, error);
      }
    });
  }

  private async addWorkspaceRoot(rootPath: string): Promise<OpenWorkspaceResult> {
    return this.runAgentSettingsOperation(async () => {
      const checkpoint = this.agentSettings.createCheckpoint();
      const result = await this.agentSettings.addWorkspaceRoot(rootPath);
      if (result.added) {
        try {
          await this.applyAgentSettings(result.settings);
          this.notifyWorkspaceSettingsChanged(result.settings);
        } catch (error) {
          return this.rollbackAgentSettings(checkpoint, error);
        }
      }
      return { workspaceId: result.workspace.workspaceId, rootPath: result.workspace.rootPath };
    });
  }

  private async setWorkspacePinned(request: AgentWorkspacePinUpdate): Promise<AgentSettingsView> {
    return this.runAgentSettingsOperation(async () => {
      const saved = await this.agentSettings.setWorkspacePinned(request.workspaceId, request.pinned);
      this.notifyWorkspaceSettingsChanged(saved);
      return saved;
    });
  }

  private async archiveWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView> {
    return this.runAgentSettingsOperation(async () => {
      const saved = await this.agentSettings.archiveWorkspace(request.workspaceId);
      this.notifyWorkspaceSettingsChanged(saved);
      this.scheduleArchivedWorkspaceCleanup();
      return saved;
    });
  }

  private async restoreWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView> {
    return this.runAgentSettingsOperation(async () => {
      const saved = await this.agentSettings.restoreWorkspace(request.workspaceId);
      this.notifyWorkspaceSettingsChanged(saved);
      this.scheduleArchivedWorkspaceCleanup();
      return saved;
    });
  }

  private async cleanupDueArchivedWorkspaces(): Promise<void> {
    await this.runAgentSettingsOperation(async () => {
      let latestSettings: AgentSettingsView | null = null;
      for (const workspaceId of this.agentSettings.dueArchivedWorkspaceIds()) {
        const result = await this.runtime.request({
          kind: 'companion.workspaces.purge',
          workspaceId
        });
        if (result.kind !== 'companion.workspace.purged' || result.workspaceId !== workspaceId) {
          throw new Error('Runtime did not confirm archived workspace cleanup.');
        }
        latestSettings = await this.agentSettings.markWorkspacePurged(workspaceId);
      }
      if (latestSettings) this.notifyWorkspaceSettingsChanged(latestSettings);
      this.scheduleArchivedWorkspaceCleanup();
    });
  }

  private scheduleArchivedWorkspaceCleanup(minimumDelayMs = 0): void {
    if (this.workspaceArchiveCleanupTimer) clearTimeout(this.workspaceArchiveCleanupTimer);
    this.workspaceArchiveCleanupTimer = null;
    const nextPurgeAt = this.agentSettings.nextArchivedWorkspacePurgeAt();
    if (!nextPurgeAt || this.isQuitting) return;
    const delay = Math.min(
      2_147_483_647,
      Math.max(minimumDelayMs, Date.parse(nextPurgeAt) - Date.now(), 0)
    );
    this.workspaceArchiveCleanupTimer = setTimeout(() => {
      this.workspaceArchiveCleanupTimer = null;
      void this.cleanupDueArchivedWorkspaces().catch((error: unknown) => {
        console.error('Archived workspace cleanup failed and will be retried.', error);
        this.scheduleArchivedWorkspaceCleanup(60_000);
      });
    }, delay);
  }

  private notifyWorkspaceSettingsChanged(settings: AgentSettingsView): void {
    this.mainWindow.get()?.webContents.send(IPC_CHANNELS.agentWorkspacesChanged, settings);
  }

  private async applyAgentSettings(saved: AgentSettingsView): Promise<void> {
    this.workspaceFiles.setWorkspaces(saved.workspaces);
    this.browser.configure(
      saved.runtimePolicy.browser,
      saved.workspaces[0]?.workspaceId ?? 'primary'
    );
    await this.mcpRemote.configure(saved.runtimePolicy.mcp.servers);
    await this.runtime.restart(this.createRuntimeConfiguration());
  }

  private async rollbackAgentSettings(
    checkpoint: ReturnType<AgentSettingsRepository['createCheckpoint']>,
    originalError: unknown
  ): Promise<never> {
    try {
      const restored = await this.agentSettings.restore(checkpoint);
      await this.applyAgentSettings(restored);
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Runtime 配置应用失败，且恢复上一份设置时发生错误。'
      );
    }
    throw originalError;
  }

  private runAgentSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.agentSettingsOperationQueue.then(operation);
    this.agentSettingsOperationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private requestQuit(): void {
    this.isQuitting = true;
    app.quit();
  }

  private async createTray(): Promise<Tray> {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    const tray = new Tray(icon);
    tray.setToolTip('Ariadne');
    tray.on('double-click', () => this.showFromUserActionSafely());
    this.updateTrayMenu(tray);
    return tray;
  }

  private updateTrayMenu(tray = this.tray): void {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示 Ariadne',
          click: () => this.showFromUserActionSafely()
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => this.requestQuit()
        }
      ])
    );
  }

  private showFromUserActionSafely(): void {
    void this.showFromUserAction().catch((error: unknown) => {
      console.error('Application could not be shown.', error);
    });
  }
}
