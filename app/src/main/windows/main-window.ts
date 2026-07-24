import { BrowserWindow, nativeTheme, type WebContents, type WebPreferences } from 'electron';
import { join } from 'node:path';
import type { ShowWindowRequest, ShowWindowResult } from '@shared/contract';
import type { StateRepository } from '../persistence/state-repository';
import type { GameActivityDetector } from '../services/system-capabilities';
import { InterruptionPolicy } from '../services/interruption-policy';
import { resolveWindowOptions } from './window-state';
import { RENDERER_PARTITION } from './renderer-source';
import { isCurrentDocumentNavigation, isTrustedDockviewPopoutUrl } from './window-navigation-policy';

const POPOUT_MINIMUM_WIDTH = 320;
const POPOUT_MINIMUM_HEIGHT = 240;

export class MainWindowController {
  private window: BrowserWindow | null = null;
  private rendererUrl: string | null = null;
  private rendererLoadPromise: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly popoutWindows = new Set<BrowserWindow>();

  constructor(
    private readonly state: StateRepository,
    private readonly gameActivity: GameActivityDetector,
    private readonly interruptionPolicy: InterruptionPolicy,
    private readonly shouldQuit: () => boolean,
    private readonly requestQuit: () => void
  ) {}

  create(rendererUrl = this.rendererUrl): BrowserWindow {
    if (!rendererUrl) throw new Error('Renderer source is unavailable.');
    this.rendererUrl = rendererUrl;
    const saved = this.state.getSnapshot().window;
    const preload = join(__dirname, '../preload/index.cjs');
    const mainWebPreferences: WebPreferences = {
      preload,
      partition: RENDERER_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: process.env.ARIADNE_SMOKE_TEST !== '1',
      webSecurity: true,
      allowRunningInsecureContent: false
    };
    const popoutWebPreferences: WebPreferences = {
      partition: RENDERER_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: process.env.ARIADNE_SMOKE_TEST !== '1',
      webSecurity: true,
      allowRunningInsecureContent: false
    };
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
      webPreferences: mainWebPreferences
    });

    this.window = window;
    if (saved.isMaximized) window.maximize();

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!isTrustedDockviewPopoutUrl(rendererUrl, url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          minWidth: POPOUT_MINIMUM_WIDTH,
          minHeight: POPOUT_MINIMUM_HEIGHT,
          autoHideMenuBar: true,
          backgroundColor: this.getPopoutBackgroundColor(),
          title: 'Ariadne',
          titleBarStyle: 'default',
          webPreferences: popoutWebPreferences
        }
      };
    });
    window.webContents.on('did-create-window', (child, details) => {
      if (!isTrustedDockviewPopoutUrl(rendererUrl, details.url)) {
        child.destroy();
        return;
      }
      this.popoutWindows.add(child);
      child.once('closed', () => this.popoutWindows.delete(child));
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedDockviewPopoutUrl(rendererUrl, url)) event.preventDefault();
      });
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!isCurrentDocumentNavigation(window.webContents.getURL(), url)) event.preventDefault();
    });
    window.once('ready-to-show', () => {
      if (process.env.ARIADNE_SMOKE_TEST !== '1') window.show();
    });
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
      this.rendererLoadPromise = null;
    });

    this.rendererLoadPromise = window.loadURL(rendererUrl);

    return window;
  }

  get(): BrowserWindow | null {
    return this.window;
  }

  getPrivilegedRendererContents(): WebContents[] {
    const contents = this.window?.webContents;
    return contents && !contents.isDestroyed() ? [contents] : [];
  }

  getPopoutWindows(): BrowserWindow[] {
    return [...this.popoutWindows].filter((candidate) => !candidate.isDestroyed());
  }

  async waitUntilRendererLoaded(): Promise<void> {
    if (!this.rendererLoadPromise) throw new Error('Renderer load has not started.');
    await this.rendererLoadPromise;
  }

  isApplicationFocused(): boolean {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !this.window) return false;
    return focused === this.window || this.popoutWindows.has(focused);
  }

  private getPopoutBackgroundColor(): string {
    const preference = this.state.getPreferences().theme;
    const dark = preference === 'dark' || (preference === 'system' && nativeTheme.shouldUseDarkColors);
    return dark ? '#0d0f13' : '#eceef2';
  }

  hide(): void {
    this.window?.hide();
  }

  async show(request: ShowWindowRequest): Promise<ShowWindowResult> {
    const window = this.window ?? this.create();
    await this.waitUntilRendererLoaded();
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
    this.saveTimer = setTimeout(() => {
      void this.saveWindowStateNow().catch((error: unknown) => {
        console.error('Window state could not be saved.', error);
      });
    }, 350);
  }
}
