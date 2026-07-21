import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { ShowWindowRequest, ShowWindowResult } from '@shared/contract';
import type { StateRepository } from '../persistence/state-repository';
import type { GameActivityDetector } from '../services/system-capabilities';
import { InterruptionPolicy } from '../services/interruption-policy';
import { resolveWindowOptions } from './window-state';

export class MainWindowController {
  private window: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly state: StateRepository,
    private readonly gameActivity: GameActivityDetector,
    private readonly interruptionPolicy: InterruptionPolicy,
    private readonly shouldQuit: () => boolean,
    private readonly requestQuit: () => void
  ) {}

  create(): BrowserWindow {
    const saved = this.state.getSnapshot().window;
    const window = new BrowserWindow({
      ...resolveWindowOptions(saved),
      minWidth: 760,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#090b10',
      title: 'Ariadne',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#111318',
        symbolColor: '#d9dde7',
        height: 44
      },
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    this.window = window;
    if (saved.isMaximized) window.maximize();

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    window.once('ready-to-show', () => window.show());
    window.on('resize', () => this.scheduleWindowStateSave());
    window.on('move', () => this.scheduleWindowStateSave());
    window.on('close', (event) => {
      if (this.shouldQuit()) return;
      event.preventDefault();
      if (this.state.getPreferences().runInBackground) window.hide();
      else this.requestQuit();
    });
    window.on('closed', () => {
      this.window = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return window;
  }

  get(): BrowserWindow | null {
    return this.window;
  }

  hide(): void {
    this.window?.hide();
  }

  async show(request: ShowWindowRequest): Promise<ShowWindowResult> {
    const window = this.window ?? this.create();
    const activity = await this.gameActivity.getSnapshot();
    const decision = this.interruptionPolicy.evaluate(request, activity, this.state.getPreferences());

    if (!decision.allow) {
      return decision.reason
        ? { outcome: 'suppressed', reason: decision.reason }
        : { outcome: 'suppressed' };
    }

    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();

    if (decision.allowTemporaryTopmost) {
      window.setAlwaysOnTop(true, 'floating');
      setTimeout(() => {
        if (!window.isDestroyed()) window.setAlwaysOnTop(false);
      }, 800);
    }

    return { outcome: 'shown' };
  }

  async saveWindowStateNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    await this.state.saveWindowState({
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized()
    });
  }

  private scheduleWindowStateSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveWindowStateNow(), 350);
  }
}
