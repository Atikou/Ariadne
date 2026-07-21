import { app, Menu, Tray } from 'electron';
import { join } from 'node:path';
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
import { MainWindowController } from './windows/main-window';

export class ApplicationController {
  private isQuitting = false;
  private cleanupPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private tray: Tray | null = null;
  private removeIpcHandlers: (() => void) | null = null;
  private readonly state = new StateRepository(join(app.getPath('userData'), 'state.json'));
  private readonly gameActivity = new UnavailableGameActivityDetector();
  private readonly systemCapabilities = new SystemCapabilityCatalog(
    new ElectronAutoLaunchService(),
    this.gameActivity
  );
  private readonly terminals = new TerminalSessionService();
  private readonly workspaceFiles = new WorkspaceFileService();
  private readonly mainWindow = new MainWindowController(
    this.state,
    this.gameActivity,
    new InterruptionPolicy(),
    () => this.isQuitting,
    () => this.requestQuit()
  );

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

  async prepareToQuit(): Promise<void> {
    this.isQuitting = true;
    if (!this.cleanupPromise) {
      this.cleanupPromise = (async () => {
        await this.mainWindow.saveWindowStateNow();
        await this.state.flush();
        this.removeIpcHandlers?.();
        this.removeIpcHandlers = null;
        this.terminals.dispose();
      })();
    }
    await this.cleanupPromise;
  }

  private async startApplication(): Promise<void> {
    await this.state.initialize();
    const window = this.mainWindow.create();
    this.removeIpcHandlers = registerIpcHandlers({
      getWindow: () => this.mainWindow.get(),
      state: this.state,
      systemCapabilities: this.systemCapabilities,
      terminals: this.terminals,
      workspaceFiles: this.workspaceFiles,
      mainWindow: this.mainWindow
    });
    this.tray = await this.createTray();
    window.on('show', () => this.updateTrayMenu());
    window.on('hide', () => this.updateTrayMenu());
  }

  private requestQuit(): void {
    this.isQuitting = true;
    app.quit();
  }

  private async createTray(): Promise<Tray> {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    const tray = new Tray(icon);
    tray.setToolTip('Ariadne');
    tray.on('double-click', () => void this.showFromUserAction());
    this.updateTrayMenu(tray);
    return tray;
  }

  private updateTrayMenu(tray = this.tray): void {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示 Ariadne',
          click: () => void this.showFromUserAction()
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => this.requestQuit()
        }
      ])
    );
  }
}
