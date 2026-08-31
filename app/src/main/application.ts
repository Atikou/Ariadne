import { app, Menu, Notification, powerMonitor, shell, Tray } from 'electron';
import { isAbsolute, join } from 'node:path';
import type { RuntimeCapabilityRequest } from '@ariadne/protocol/host';
import type {
  AgentSettingsMutation,
  AgentSettingsMutationResult,
  AgentSettingsOperation,
  AgentSettingsView,
  AgentWorkspacePinUpdate,
  AgentWorkspaceRequest,
  ActivateSpeechVoiceRequest,
  ApplicationProfileView,
  SpeechStatus,
  OpenWorkspaceResult
} from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { applicationProfileComponents, compileApplicationProfile } from '@shared/application-profile';
import { AgentSettingsRepository } from './persistence/agent-settings-repository';
import { AgentInputDeliveryOutbox } from './persistence/agent-input-delivery-outbox';
import { AgentPersistenceKeyRingStore } from './persistence/agent-persistence-keyring';
import { McpOAuthCredentialVault } from './persistence/mcp-oauth-credential-vault';
import { ElectronSafeStorageCipher } from './persistence/secret-cipher';
import { StateRepository } from './persistence/state-repository';
import { TerminalSessionJournal } from './persistence/terminal-session-journal';
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
import { ComputerReadService } from './services/computer-read-service';
import { McpRemoteService } from './runtime/mcp-remote-service';
import { MainCredentialAuthority } from './runtime/credential-authority';
import { PreferencesCoordinator } from './services/preferences-coordinator';
import { MainWindowController } from './windows/main-window';
import { RendererSource } from './windows/renderer-source';
import { createDesktopRuntimeConfiguration } from './runtime/runtime-configuration';
import { RuntimeSupervisor } from './runtime/runtime-supervisor';
import { runElectronSmokeTest } from './smoke/electron-smoke';
import { shouldRestartRuntimeForAgentSettings } from './settings/agent-settings-effects';
import { compileSpeechEntity } from './speech/entity/speech-entity-compiler';
import { resolveApplicationProfile } from './profiles/application-profiles';

export class ApplicationController {
  private isQuitting = false;
  private cleanupPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private agentSettingsOperationQueue: Promise<void> = Promise.resolve();
  private tray: Tray | null = null;
  private removeIpcHandlers: (() => void) | null = null;
  private removeApprovalNotificationEvents: (() => void) | null = null;
  private removeSpeechEvents: (() => void) | null = null;
  private readonly state = new StateRepository(join(app.getPath('userData'), 'state.json'));
  private readonly secretCipher = new ElectronSafeStorageCipher();
  private readonly agentInputDeliveryOutbox = new AgentInputDeliveryOutbox(
    join(app.getPath('userData'), 'agent-input-delivery-outbox.json'),
    this.secretCipher
  );
  private readonly agentSettings = new AgentSettingsRepository(
    join(app.getPath('userData'), 'settings.toml'),
    this.secretCipher
  );
  private readonly mcpOAuthVault = new McpOAuthCredentialVault(
    join(app.getPath('userData'), 'mcp-oauth-vault.json'),
    this.secretCipher
  );
  private readonly agentPersistenceKeyRing = new AgentPersistenceKeyRingStore(
    join(app.getPath('userData'), 'agent-persistence-keyring.json'),
    this.secretCipher
  );
  private readonly credentials = new MainCredentialAuthority(
    this.agentSettings,
    this.mcpOAuthVault
  );
  private readonly mcpRemote = new McpRemoteService(
    this.credentials,
    async (url) => {
      await shell.openExternal(url);
    }
  );
  private readonly gameActivity = new UnavailableGameActivityDetector();
  private readonly interruptionPolicy = new InterruptionPolicy();
  private readonly applicationProfileDefinition = resolveApplicationProfile();
  private applicationProfile: ApplicationProfileView | null = null;
  private readonly speech = compileSpeechEntity(applicationProfileComponents(
    this.applicationProfileDefinition,
    'speech'
  ));
  private readonly systemCapabilities = new SystemCapabilityCatalog(
    new ElectronAutoLaunchService(),
    this.gameActivity,
    this.speech
  );
  private readonly preferences = new PreferencesCoordinator(this.state, this.systemCapabilities);
  private readonly workspaceFiles = new WorkspaceFileService([]);
  private readonly terminalJournal = new TerminalSessionJournal(
    join(app.getPath('userData'), 'terminal-sessions.json')
  );
  private readonly terminals = new TerminalSessionService(
    (workspaceId) => this.workspaceFiles.getRoot(workspaceId),
    this.terminalJournal
  );
  private readonly browser = new BrowserService({
    audit: (event) => {
      console.info('[browser-audit]', JSON.stringify(event));
    }
  });
  private readonly computerRead = new ComputerReadService((path) => shell.openPath(path));
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
        await this.agentInputDeliveryOutbox.flush();
        this.removeIpcHandlers?.();
        this.removeIpcHandlers = null;
        this.removeApprovalNotificationEvents?.();
        this.removeApprovalNotificationEvents = null;
        this.approvalNotifications.dispose();
        powerMonitor.removeListener('lock-screen', this.handleSpeechLock);
        powerMonitor.removeListener('unlock-screen', this.handleSpeechUnlock);
        powerMonitor.removeListener('suspend', this.handleSpeechLock);
        powerMonitor.removeListener('resume', this.handleSpeechUnlock);
        this.removeSpeechEvents?.();
        this.removeSpeechEvents = null;
        await this.speech.dispose();
        await this.runtime.stop('app_quit');
        await this.mcpRemote.dispose();
        await this.mcpOAuthVault.flush();
        this.browser.dispose();
        this.rendererSource.stop();
        await this.terminals.dispose();
        this.tray?.destroy();
        this.tray = null;
      })();
    }
    await this.cleanupPromise;
  }

  private async startApplication(): Promise<void> {
    this.applicationProfile = await compileApplicationProfile(this.applicationProfileDefinition);
    await Promise.all([
      this.state.initialize(),
      this.agentSettings.initialize(),
      this.agentInputDeliveryOutbox.initialize(),
      this.mcpOAuthVault.initialize(),
      this.agentPersistenceKeyRing.initialize(),
      this.terminals.initialize()
    ]);
    await this.speech.initialize(this.state.getPreferences().speech);
    if (process.env.ARIADNE_SMOKE_TEST === '1') {
      const smokeWorkspaceRoot = process.env.ARIADNE_SMOKE_WORKSPACE_ROOT;
      const expectedWorkspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID;
      if (!smokeWorkspaceRoot || !isAbsolute(smokeWorkspaceRoot) || !expectedWorkspaceId) {
        throw new Error('Electron smoke workspace identity is not configured.');
      }
      const opened = await this.agentSettings.addWorkspaceRoot(smokeWorkspaceRoot);
      if (opened.workspace.workspaceId !== expectedWorkspaceId) {
        throw new Error('Electron smoke workspace identity does not match settings authority.');
      }
    }
    const initialRuntimeSettings = this.agentSettings.getRuntimeSettings();
    this.workspaceFiles.setWorkspaces(initialRuntimeSettings.workspaces);
    this.browser.configure(
      initialRuntimeSettings.runtimePolicy.browser,
      null
    );
    await this.mcpRemote.configure(initialRuntimeSettings.runtimePolicy.mcp.servers);
    this.runtime.configure(this.createRuntimeConfiguration());
    const rendererUrl = this.rendererSource.start();
    const window = this.mainWindow.create(rendererUrl);
    this.removeIpcHandlers = registerIpcHandlers({
      getWindow: () => this.mainWindow.get(),
      agentSettings: this.agentSettings,
      applyAgentSettings: (mutation) => this.applyAgentSettingsMutation(mutation),
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
      agentInputDeliveryOutbox: this.agentInputDeliveryOutbox,
      speech: this.speech,
      getApplicationProfile: () => {
        if (!this.applicationProfile) throw new Error('application_profile_not_compiled');
        return this.applicationProfile;
      },
      activateSpeechVoice: (request) => this.activateSpeechVoice(request),
      mainWindow: this.mainWindow,
      testApprovalNotification: () => this.approvalNotifications.showTestNotification()
    });
    this.removeApprovalNotificationEvents = this.runtime.onEvent((event) => {
      void this.approvalNotifications.handleRuntimeEvent(event.event).catch((error: unknown) => {
        console.error('Approval notification event handling failed.', error);
      });
    });
    this.removeSpeechEvents = this.speech.onEvent((event) => {
      if (event.kind === 'status' || event.kind === 'wake' || event.kind.startsWith('tts.')) {
        this.updateTrayMenu();
      }
    });
    powerMonitor.on('lock-screen', this.handleSpeechLock);
    powerMonitor.on('unlock-screen', this.handleSpeechUnlock);
    powerMonitor.on('suspend', this.handleSpeechLock);
    powerMonitor.on('resume', this.handleSpeechUnlock);
    await this.mainWindow.waitUntilRendererLoaded();
    void this.runtime.start().catch(() => {
      console.error('Runtime was unavailable during application startup.');
    });
    this.tray = await this.createTray();
    window.on('show', () => {
      this.speech.setBackground(false);
      this.updateTrayMenu();
    });
    window.on('hide', () => {
      this.speech.setBackground(true);
      this.updateTrayMenu();
    });
    this.speech.setBackground(!window.isVisible());
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
        if (request.capability === 'computer_read') return this.computerRead.handle(request.operation);
        if (request.capability === 'browser') return this.browser.handle(request.operation);
        if (request.capability === 'mcp_remote') return this.mcpRemote.handle(request.operation);
        if (request.capability === 'agent_persistence') {
          const keyRing = await this.agentPersistenceKeyRing.loadForRuntime();
          return {
            ...keyRing,
            runtimeInstanceId: request.runtimeInstanceId
          };
        }
        if (request.capability === 'credential') {
          return this.credentials.handle(request.operation);
        }
        throw new Error('host_capability_unknown');
      }
    };
  }

  private async applyAgentSettingsMutation(
    mutation: AgentSettingsMutation
  ): Promise<AgentSettingsMutationResult> {
    return this.runAgentSettingsOperation(async () => {
      const checkpoint = this.agentSettings.createCheckpoint();
      const result = this.credentials.acceptsUpdate(mutation)
        ? await this.credentials.update(mutation)
        : await this.agentSettings.mutate(mutation);
      if (!result.ok) return result;
      try {
        await this.applyCommittedAgentSettings(result.settings, result.effect, mutation.operations);
        if (mutation.operations.some((operation) => operation.kind === 'permissions.set')) {
          this.notifyWorkspaceSettingsChanged(result.settings);
        }
        return result;
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
          await this.applyAllAgentSettings(result.settings);
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
      const checkpoint = this.agentSettings.createCheckpoint();
      const saved = await this.agentSettings.archiveWorkspace(request.workspaceId);
      try {
        await this.applyAllAgentSettings(saved);
        this.notifyWorkspaceSettingsChanged(saved);
        return saved;
      } catch (error) {
        return this.rollbackAgentSettings(checkpoint, error);
      }
    });
  }

  private async restoreWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView> {
    return this.runAgentSettingsOperation(async () => {
      const checkpoint = this.agentSettings.createCheckpoint();
      const saved = await this.agentSettings.restoreWorkspace(request.workspaceId);
      try {
        await this.applyAllAgentSettings(saved);
        this.notifyWorkspaceSettingsChanged(saved);
        return saved;
      } catch (error) {
        return this.rollbackAgentSettings(checkpoint, error);
      }
    });
  }


  private notifyWorkspaceSettingsChanged(settings: AgentSettingsView): void {
    this.mainWindow.get()?.webContents.send(IPC_CHANNELS.agentWorkspacesChanged, settings);
  }

  private async applyCommittedAgentSettings(
    saved: AgentSettingsView,
    effect: Extract<AgentSettingsMutationResult, { ok: true }>['effect'],
    operations: readonly AgentSettingsOperation[]
  ): Promise<void> {
    const changesWorkspaceBoundary = operations.some((operation) => (
      operation.kind === 'permissions.set'
    ));
    const changesRuntimePolicy = operations.some((operation) => operation.kind === 'runtimePolicy.replace');
    const activeWorkspaces = saved.workspaces.filter((workspace) => workspace.archivedAt === undefined);
    if (changesWorkspaceBoundary) this.workspaceFiles.setWorkspaces(activeWorkspaces);
    if (changesWorkspaceBoundary || changesRuntimePolicy) {
      this.browser.configure(
        saved.runtimePolicy.browser,
        null
      );
    }
    if (changesRuntimePolicy) await this.mcpRemote.configure(saved.runtimePolicy.mcp.servers);
    if (shouldRestartRuntimeForAgentSettings(effect)) {
      await this.synchronizeRuntime();
    }
  }

  private async applyAllAgentSettings(saved: AgentSettingsView): Promise<void> {
    const activeWorkspaces = saved.workspaces.filter((workspace) => workspace.archivedAt === undefined);
    this.workspaceFiles.setWorkspaces(activeWorkspaces);
    this.browser.configure(
      saved.runtimePolicy.browser,
      null
    );
    await this.mcpRemote.configure(saved.runtimePolicy.mcp.servers);
    await this.synchronizeRuntime();
  }

  private async synchronizeRuntime(): Promise<void> {
    const configuration = this.createRuntimeConfiguration();
    if (this.runtime.getStatus().availability === 'stopped') {
      this.runtime.configure(configuration);
      await this.runtime.start();
      return;
    }
    await this.runtime.restart(configuration);
  }

  private async rollbackAgentSettings(
    checkpoint: ReturnType<AgentSettingsRepository['createCheckpoint']>,
    originalError: unknown
  ): Promise<never> {
    try {
      const restored = await this.agentSettings.restore(checkpoint);
      await this.applyAllAgentSettings(restored);
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

  private readonly handleSpeechLock = (): void => {
    this.speech.setLockedOrSuspended(true);
  };

  private readonly handleSpeechUnlock = (): void => {
    this.speech.setLockedOrSuspended(false);
  };

  private async activateSpeechVoice(request: ActivateSpeechVoiceRequest) {
    const voice = await this.speech.activateVoice(request);
    const preferences = this.state.getPreferences();
    await this.preferences.update({
      ...preferences,
      speech: {
        ...preferences.speech,
        activeVoiceId: request.voiceId,
        activeVoiceVersion: request.version
      }
    });
    return voice;
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
    const speech = this.speech.getStatus();
    tray.setToolTip(`Ariadne · 语音${speechLabel(speech.activity, speech.availability)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示 Ariadne',
          click: () => this.showFromUserActionSafely()
        },
        {
          label: `语音：${speechLabel(speech.activity, speech.availability)}`,
          enabled: false
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

function speechLabel(
  activity: SpeechStatus['activity'],
  availability: SpeechStatus['availability']
): string {
  if (availability === 'disabled') return '已关闭';
  if (availability === 'unavailable') return '未安装';
  switch (activity) {
    case 'waking': return '已唤醒';
    case 'listening': return '正在聆听';
    case 'transcribing': return '正在转写';
    case 'speaking': return '正在播报';
    case 'error': return '异常';
    case 'idle': return availability === 'degraded' ? '部分可用' : '就绪';
  }
}
