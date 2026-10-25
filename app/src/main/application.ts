import { app, dialog, Menu, Notification, powerMonitor, shell, Tray } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
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
import { FileDecisionNotificationReceipts } from './persistence/decision-notification-receipts';
import { TaskNotificationReceipts } from './persistence/task-notification-receipts';
import { TaskNotificationSource } from './services/task-notification-source';
import { windowsTaskNotificationOptions } from './services/task-notification-activation';
import type { TaskNotificationReference } from '@shared/task-notification';
import { InputDeliveryOutbox } from './persistence/input-delivery-outbox';
import { ChatDraftRepository } from './persistence/chat-draft-repository';
import { FileDraftRepository } from './persistence/file-draft-repository';
import { prepareRendererFileDraftQuit } from './services/renderer-file-draft-quit';
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
import { TerminalWorkingDirectoryAuthority } from './services/terminal-working-directory-authority';
import { WorkspaceFileService } from './services/workspace-file-service';
import { ApprovalNotificationService } from './services/approval-notification-service';
import { DecisionNotificationSource, type DecisionNotificationReference } from './services/decision-notification-source';
import { windowsDecisionNotificationOptions } from './services/decision-notification-activation';
import { removeDecisionNotificationHistory } from './services/windows-decision-notification-history';
import { flushRendererDraftsBeforeQuit } from './services/renderer-draft-quit';
import { execFile } from 'node:child_process';
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
import { MainMaintenanceGate } from './data-management/main-maintenance-gate';
import { DataBackupService, type DataBackupDependencies } from './data-management/data-backup-service';
import { MainOfflineDataMaintenance } from './data-management/main-offline-data-maintenance';
import { DataAttachmentCleanupService } from './data-management/data-attachment-cleanup-service';
import { measureOwnedDataUsage } from './data-management/data-usage';
import { SessionExportService } from './data-management/session-export-service';
import { WindowsBackupKeyProtector } from './runtime/windows-backup-key-protector';
import type { PublishedBackup } from './data-management/backup-bundle';
import { DataRestoreOwnersStillOpenError, DataRestoreService } from './data-management/data-restore-service';
import { dataRootSwitchHelperEntry } from './runtime/data-root-recovery-startup';
import type { DataRestorePreview, SessionTextExportRequest, SessionTextExportResult } from '@shared/data-management';

export class ApplicationController {
  private readonly mainMaintenance = new MainMaintenanceGate();
  private isQuitting = false;
  private cleanupPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private agentSettingsOperationQueue: Promise<void> = Promise.resolve();
  private tray: Tray | null = null;
  private removeIpcHandlers: (() => void) | null = null;
  private removeApprovalNotificationEvents: (() => void) | null = null;
  private removeApprovalNotificationStatus: (() => void) | null = null;
  private approvalNotificationPoll: ReturnType<typeof setInterval> | null = null;
  private removeSpeechEvents: (() => void) | null = null;
  private readonly state = new StateRepository(join(app.getPath('userData'), 'state.json'), this.mainMaintenance);
  private readonly notificationReceipts = new FileDecisionNotificationReceipts(join(app.getPath('userData'), 'decision-notifications.json'), undefined, this.mainMaintenance);
  private readonly taskNotificationReceipts = new TaskNotificationReceipts(join(app.getPath('userData'), 'notification-delivery.db'), undefined, this.mainMaintenance);
  private readonly secretCipher = new ElectronSafeStorageCipher();
  private readonly chatDrafts = new ChatDraftRepository(join(app.getPath('userData'), 'chat-drafts.json'), this.secretCipher, this.mainMaintenance);
  private readonly fileDrafts = new FileDraftRepository(join(app.getPath('userData'), 'file-drafts.json'), this.secretCipher, this.mainMaintenance);
  private readonly inputDeliveryOutbox = new InputDeliveryOutbox(
    join(app.getPath('userData'), 'agent-input-delivery-outbox.json'),
    this.secretCipher, undefined, this.mainMaintenance
  );
  private readonly agentSettings = new AgentSettingsRepository(
    join(app.getPath('userData'), 'settings.toml'),
    this.secretCipher, undefined, this.mainMaintenance
  );
  private readonly mcpOAuthVault = new McpOAuthCredentialVault(
    join(app.getPath('userData'), 'mcp-oauth-vault.json'),
    this.secretCipher, this.mainMaintenance
  );
  private readonly agentPersistenceKeyRing = new AgentPersistenceKeyRingStore(
    join(app.getPath('userData'), 'agent-persistence-keyring.json'),
    this.secretCipher, undefined, undefined, undefined, this.mainMaintenance
  );
  private readonly credentials = new MainCredentialAuthority(
    this.agentSettings,
    this.mcpOAuthVault
  );
  private readonly mcpRemote = new McpRemoteService(
    this.credentials,
    async (url) => {
      await shell.openExternal(url);
    }, undefined, this.mainMaintenance
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
  private readonly terminalWorkingDirectories = new TerminalWorkingDirectoryAuthority(
    app.getPath('userData'),
    (workspaceId) => this.workspaceFiles.getRoot(workspaceId)
  );
  private readonly terminalJournal = new TerminalSessionJournal(
    join(app.getPath('userData'), 'terminal-sessions.json'), undefined, this.mainMaintenance
  );
  private readonly terminals = new TerminalSessionService(
    (workspaceId) => this.terminalWorkingDirectories.resolve(workspaceId),
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
  private readonly decisionNotificationSource = new DecisionNotificationSource(command => this.runtime.request(command));
  private readonly taskNotificationSource = new TaskNotificationSource(command => this.runtime.request(command),
    this.taskNotificationReceipts, () => this.state.getPreferences().taskNotifications ?? { completed: false, failed: false });
  private readonly approvalNotifications = new ApprovalNotificationService({
    removeHistory: references => removeDecisionNotificationHistory(references, encodedScript => new Promise(resolve => {
      execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
        { windowsHide: true, timeout: 5_000, maxBuffer: 4_096, encoding: 'utf8' },
        (error, stdout) => resolve(error ? null : stdout));
    })),
    isSupported: () => Notification.isSupported(),
    isWindowFocused: () => this.mainWindow.isApplicationFocused(),
    canNotify: async () => this.interruptionPolicy.evaluate(
      { source: 'system', allowTemporaryTopmost: false },
      await this.gameActivity.getSnapshot(),
      this.state.getPreferences()
    ).allow,
    create: (content) => {
      const windowsDecision = process.platform === 'win32' && (content.navigation !== undefined || content.taskNavigation !== undefined);
      const notification = new Notification(windowsDecision ? (content.taskNavigation ? windowsTaskNotificationOptions(content) : windowsDecisionNotificationOptions(content))
        : { title: content.title, body: content.body });
      return {
        // The global Windows activation callback owns both warm and cold Decision
        // navigation. Instance events would dispatch the same click twice.
        onClick: (handler) => { if (!windowsDecision) notification.once('click', handler); },
        onShown: (handler) => notification.once('show', handler),
        onClosed: (handler) => notification.once('close', handler),
        onFailed: (handler) => notification.once('failed', handler),
        show: () => notification.show(),
        close: () => notification.close()
      };
    },
    activateTask: async (navigation) => {
      await this.showFromUserAction();
      if (!this.isQuitting && navigation.target) this.mainWindow.get()?.webContents.send(IPC_CHANNELS.systemApprovalNavigation,
        { sessionId: navigation.target.sessionId, taskNavigation: navigation });
    },
    activateApplication: async (sessionId, decisionId) => {
      await this.showFromUserAction();
      if (!this.isQuitting && sessionId) {
        this.mainWindow.get()?.webContents.send(
          IPC_CHANNELS.systemApprovalNavigation,
          { sessionId, decisionId }
        );
      }
    }
  }, () => this.decisionNotificationSource.read(), item => this.decisionNotificationSource.readCurrent(item), this.notificationReceipts, this.taskNotificationSource);
  private readonly dataManagementDependencies = this.createDataManagementDependencies();
  private readonly dataMaintenance = new MainOfflineDataMaintenance(this.dataManagementDependencies);
  private readonly dataBackups = new DataBackupService({ ...this.dataManagementDependencies, maintenance: this.dataMaintenance });
  private readonly attachmentCleanup = new DataAttachmentCleanupService({ maintenance: this.dataMaintenance,
    worker: this.dataManagementDependencies.runtimeWorker, loadKeys: () => this.agentPersistenceKeyRing.loadForRuntime() });
  private readonly dataRestores = this.createDataRestoreService();
  private readonly sessionExports = new SessionExportService(command => this.runtime.request(command),
    [app.getPath('userData'), app.getPath('sessionData'), this.createRuntimeConfiguration().dataRoot]);

  private async prepareDataMaintenance(): Promise<void> {
    const assertAvailable = (): void => {
      if (this.isQuitting || this.dataMaintenance.busy || this.mainMaintenance.busy || this.dataRestores.busy || this.sessionExports.busy)
        throw new Error('data_management_busy');
    };
    assertAvailable(); await this.start(); await this.runtime.start(); assertAvailable();
  }

  async exportSessionText(request: SessionTextExportRequest): Promise<SessionTextExportResult | null> {
    if (this.isQuitting || this.dataMaintenance.busy || this.mainMaintenance.busy || this.dataRestores.busy || this.sessionExports.busy) throw new Error('data_management_busy');
    await this.runtime.start();
    const options = { title: '导出会话正文（不含图像文件或工具详情）', defaultPath: 'Ariadne-session.jsonl',
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] };
    const window = this.mainWindow.get(), selected = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return null;
    if (this.isQuitting || this.dataMaintenance.busy || this.mainMaintenance.busy || this.dataRestores.busy) throw new Error('data_management_busy');
    return this.sessionExports.create(request, selected.filePath);
  }

  async inspectDataRestore(): Promise<DataRestorePreview | null> {
    await this.prepareDataMaintenance();
    const options = { title: '选择 Ariadne 备份目录', properties: ['openDirectory'] as 'openDirectory'[] };
    const window = this.mainWindow.get(), selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    await this.prepareDataMaintenance();
    return this.dataRestores.inspect(selected.filePaths[0]);
  }
  async commitDataRestore(ticket: string): Promise<void> {
    await this.prepareDataMaintenance(); await this.dataRestores.commit(ticket);
  }
  async discardDataRestore(ticket: string): Promise<void> { await this.dataRestores.discard(ticket); }

  private createDataRestoreService(): DataRestoreService {
    const configuration = this.createRuntimeConfiguration();
    if (!configuration.executablePath) throw new Error('restore_runtime_executable_missing');
    return new DataRestoreService({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
      stagingParent: app.getPath('temp'), protector: new WindowsBackupKeyProtector(),
      validation: { electronExecutable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged,
        runtimeExecutable: configuration.executablePath, runtimeEntry: join(dirname(configuration.runtimeEntry), 'storage-maintenance-process.js') },
      switchEntry: dataRootSwitchHelperEntry(app.getAppPath(), app.isPackaged),
      stopMainOwners: async () => {
        if (this.isQuitting) throw new DataRestoreOwnersStillOpenError();
        try { await this.prepareToQuit({ dataRootSwitch: true }); }
        catch (error) {
          if (!this.isQuitting) {
            for (const renderer of this.mainWindow.getPrivilegedRendererContents()) if (!renderer.isDestroyed()) await renderer.executeJavaScript(
              '{ const root=globalThis.__ariadneRendererCompositionRootV1; if(root) { root.services.drafts.resumeAfterCancelledQuit(); root.services.documents.resumeAfterCancelledQuit(); } }');
            throw new DataRestoreOwnersStillOpenError();
          }
          throw error;
        }
      }, exitMain: code => app.exit(code) });
  }

  async createDataBackup(): Promise<PublishedBackup | null> {
    await this.prepareDataMaintenance();
    const options = { title: '选择备份保存位置', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const window = this.mainWindow.get(), selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    await this.prepareDataMaintenance();
    return this.dataBackups.create(selected.filePaths[0]);
  }

  private createDataManagementDependencies(): DataBackupDependencies {
    const configuration = this.createRuntimeConfiguration();
    if (!configuration.executablePath) throw new Error('backup_runtime_executable_missing');
    return { userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
      stagingParent: app.getPath('temp'), appVersion: app.getVersion(), gate: this.mainMaintenance, runtime: this.runtime,
      runtimeWorker: { entry: join(dirname(configuration.runtimeEntry), 'storage-maintenance-process.js'),
        executablePath: configuration.executablePath, dataRoot: configuration.dataRoot },
      taskNotificationReceipts: this.taskNotificationReceipts, protector: new WindowsBackupKeyProtector(),
      prepareRendererDrafts: async () => {
        const contents = this.mainWindow.getPrivilegedRendererContents();
        if (!contents.length) throw new Error('backup_renderer_unavailable');
        for (const renderer of contents) if (renderer.isDestroyed() || !await renderer.executeJavaScript(
          'Boolean(globalThis.__ariadneRendererCompositionRootV1?.services.drafts && globalThis.__ariadneRendererCompositionRootV1?.services.documents)'))
          throw new Error('backup_renderer_unavailable');
        await flushRendererDraftsBeforeQuit(contents);
      },
      resumeRendererDrafts: async () => {
        for (const renderer of this.mainWindow.getPrivilegedRendererContents()) if (!renderer.isDestroyed()) await renderer.executeJavaScript(
          '{ const root=globalThis.__ariadneRendererCompositionRootV1; if(root) { root.services.drafts.resumeAfterCancelledQuit(); root.services.documents.resumeAfterCancelledQuit(); } }');
      },
      pauseNotifications: () => this.approvalNotifications.pauseForMaintenance(),
      resumeNotifications: () => this.approvalNotifications.resumeAfterMaintenance(),
      beforeFreeze: async () => { await this.mainWindow.saveWindowStateNow(); },
      stopMainRuntimeProducers: () => this.mcpRemote.dispose(),
      flushMainOwners: async () => {
        await this.agentSettingsOperationQueue; await this.preferences.flush();
        await this.state.flush(); await this.agentSettings.flush(); await this.inputDeliveryOutbox.flush();
        await this.chatDrafts.flush(); await this.fileDrafts.flush(); await this.notificationReceipts.flush();
        await this.mcpOAuthVault.flush(); await this.terminalJournal.flush();
      }
    };
  }

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startApplication();
    }
    await this.startPromise;
  }

  async activateDecisionNotification(reference: DecisionNotificationReference): Promise<void> {
    if (this.isQuitting) return;
    await this.start();
    if (!this.isQuitting) await this.approvalNotifications.activateReference(reference);
  }

  async activateTaskNotification(reference: TaskNotificationReference): Promise<void> {
    if (this.isQuitting) return;
    await this.start();
    if (!this.isQuitting) await this.approvalNotifications.activateTaskReference(reference);
  }

  async showFromUserAction(): Promise<void> {
    if (this.isQuitting) return;
    await app.whenReady();
    await this.start();
    if (this.isQuitting) return;
    await this.mainWindow.show({ source: 'user', allowTemporaryTopmost: false });
  }

  async runSmokeTest(outputRoot: string): Promise<boolean> {
    const window = this.mainWindow.get();
    if (!window) throw new Error('Main window is unavailable for smoke verification.');
    return runElectronSmokeTest(window, outputRoot);
  }

  async handleOpenUrl(rawUrl: string): Promise<boolean> {
    await app.whenReady();
    await this.start();
    return this.mcpRemote.handleOAuthCallback(rawUrl);
  }

  async prepareToQuit(options?: { dataRootSwitch: true }): Promise<void> {
    this.isQuitting = true;
    if (!this.cleanupPromise) {
      this.cleanupPromise = (async () => {
        try {
          // Do not destroy a notification connection, profile or Runtime while
          // its admitted snapshot/publishing operation still owns them.
          await this.dataBackups.waitForIdle();
          this.attachmentCleanup.disposePreview();
          await this.sessionExports.waitForIdle();
          if (!options?.dataRootSwitch) await this.dataRestores.waitForIdle();
          await prepareRendererFileDraftQuit(this.mainWindow.getPrivilegedRendererContents(), options => {
            const window = this.mainWindow.get();
            return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
          });
          await flushRendererDraftsBeforeQuit(this.mainWindow.getPrivilegedRendererContents());
        }
        catch (error) { this.isQuitting = false; this.cleanupPromise = null; throw error; }
        let ownersClosing = false;
        const closeOwners = async (): Promise<void> => {
        if (options?.dataRootSwitch) await this.runtime.shutdownForDataRootSwitch();
        ownersClosing = true;
        this.removeApprovalNotificationEvents?.();
        this.removeApprovalNotificationEvents = null;
        this.removeApprovalNotificationStatus?.();
        this.removeApprovalNotificationStatus = null;
        if (this.approvalNotificationPoll) clearInterval(this.approvalNotificationPoll);
        this.approvalNotificationPoll = null;
        this.approvalNotifications.dispose();
        this.taskNotificationReceipts.close();
        await this.agentSettingsOperationQueue;
        await this.preferences.flush();
        await this.mainWindow.saveWindowStateNow();
        await this.state.flush();
        await this.agentSettings.flush();
        await this.inputDeliveryOutbox.flush();
        await this.chatDrafts.flush();
        await this.fileDrafts.flush();
        await this.notificationReceipts.flush();
        this.mainWindow.destroyWindows();
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
        this.removeIpcHandlers?.();
        this.removeIpcHandlers = null;
        this.tray?.destroy();
        this.tray = null;
        if (!options?.dataRootSwitch) await this.dataRestores.disposePreview();
        };
        if (options?.dataRootSwitch) {
          try { await this.mainMaintenance.withOwnerShutdown(closeOwners); }
          catch (error) {
            if (!ownersClosing) { this.isQuitting = false; this.cleanupPromise = null; }
            throw error;
          }
        } else await closeOwners();
      })();
    }
    await this.cleanupPromise;
  }

  private async startApplication(): Promise<void> {
    await this.secretCipher.initialize();
    this.applicationProfile = await compileApplicationProfile(this.applicationProfileDefinition);
    await Promise.all([
      this.state.initialize(),
      this.notificationReceipts.initialize(),
      this.taskNotificationReceipts.initialize(),
      this.agentSettings.initialize(),
      this.inputDeliveryOutbox.initialize(),
      this.chatDrafts.initialize(),
      this.fileDrafts.initialize(),
      this.mcpOAuthVault.initialize(),
      this.agentPersistenceKeyRing.initialize(),
      this.terminals.initialize()
    ]);
    this.taskNotificationSource.configure();
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
      writeAdmission: this.mainMaintenance,
      dataManagement: {
        inspectCleanup: async () => { await this.prepareDataMaintenance(); return this.attachmentCleanup.inspect(); },
        commitCleanup: async request => { await this.prepareDataMaintenance(); return this.attachmentCleanup.commit(request); },
        discardCleanup: async request => { this.attachmentCleanup.discard(request.ticket); },
        exportSession: request => this.exportSessionText(request),
        measureUsage: async () => {
          if (this.isQuitting || this.dataMaintenance.busy || this.mainMaintenance.busy || this.dataRestores.busy) throw new Error('data_management_busy');
          await this.runtime.start();
          return measureOwnedDataUsage({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
            runtime: this.createRuntimeConfiguration().dataRoot });
        },
        createBackup: async () => { const backup = await this.createDataBackup();
          return backup ? { backupId: backup.backupId, files: backup.files, bytes: backup.bytes } : null; },
        inspectRestore: () => this.inspectDataRestore(), commitRestore: request => this.commitDataRestore(request.ticket),
        discardRestore: request => this.discardDataRestore(request.ticket)
      },
      getWindow: () => this.mainWindow.get(),
      agentSettings: this.agentSettings,
      applyAgentSettings: (mutation) => this.applyAgentSettingsMutation(mutation),
      setWorkspacePinned: (request) => this.setWorkspacePinned(request),
      archiveWorkspace: (request) => this.archiveWorkspace(request),
      restoreWorkspace: (request) => this.restoreWorkspace(request),
      updatePreferences: async (preferences) => {
        const saved = await this.preferences.update(preferences);
        this.taskNotificationSource.configure();
        this.refreshApprovalNotifications();
        return saved;
      },
      addWorkspaceRoot: (rootPath) => this.addWorkspaceRoot(rootPath),
      state: this.state,
      systemCapabilities: this.systemCapabilities,
      terminals: this.terminals,
      workspaceFiles: this.workspaceFiles,
      runtime: this.runtime,
      inputDeliveryOutbox: this.inputDeliveryOutbox,
      chatDrafts: this.chatDrafts,
      fileDrafts: this.fileDrafts,
      speech: this.speech,
      getApplicationProfile: () => {
        if (!this.applicationProfile) throw new Error('application_profile_not_compiled');
        return JSON.parse(JSON.stringify(this.applicationProfile)) as ApplicationProfileView;
      },
      activateSpeechVoice: (request) => this.activateSpeechVoice(request),
      mainWindow: this.mainWindow,
      testApprovalNotification: () => this.approvalNotifications.showTestNotification()
    });
    this.removeApprovalNotificationEvents = this.runtime.onEvent((event) => {
      if (event.event.kind === 'projection.changed') this.refreshApprovalNotifications();
    });
    this.removeApprovalNotificationStatus = this.runtime.onStatus(status => {
      if (status.availability === 'ready') this.refreshApprovalNotifications();
    });
    this.approvalNotificationPoll = setInterval(() => {
      if (this.runtime.getStatus().availability === 'ready') this.refreshApprovalNotifications();
    }, 15_000);
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
      this.refreshApprovalNotifications();
      this.speech.setBackground(true);
      this.updateTrayMenu();
    });
    this.speech.setBackground(!window.isVisible());
  }

  private refreshApprovalNotifications(): void {
    if (this.isQuitting) return;
    void this.approvalNotifications.refresh().catch(() => {
      if (!this.isQuitting) console.error('Decision notification synchronization failed.');
    });
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
    return this.mainMaintenance.write(() => {
    const result = this.agentSettingsOperationQueue.then(operation);
    this.agentSettingsOperationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
    });
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
