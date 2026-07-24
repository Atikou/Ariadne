import { createHash, randomUUID } from 'node:crypto';

import {
  WebContentsView,
  type Session,
  type WebContents
} from 'electron';
import type { BrowserCapabilityOperation } from '@ariadne/protocol/host';
import {
  createDefaultRuntimePolicySnapshot,
  type RuntimePolicySnapshot
} from '@ariadne/protocol/settings';

const MAX_SNAPSHOT_CHARS = 200_000;
type BrowserPolicy = RuntimePolicySnapshot['browser'];

export interface BrowserAuditEvent {
  operation: BrowserCapabilityOperation['kind'];
  outcome: 'allowed' | 'blocked' | 'completed' | 'failed';
  target?: string;
  detail?: string;
}

export interface BrowserEngine {
  health(): Promise<void>;
  navigate(url: string): Promise<{ url: string; title: string }>;
  accessibilitySnapshot(maxChars: number): Promise<{ url: string; title: string; text: string }>;
  screenshot(): Promise<Buffer>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  download(url: string, maxBytes: number): Promise<{ bytes: Buffer; mediaType: string; name: string }>;
  dispose(): void;
}

export interface BrowserServiceOptions {
  engine?: BrowserEngine;
  audit?: (event: BrowserAuditEvent) => void;
  policy?: BrowserPolicy;
  workspaceId?: string;
}

/**
 * Main-owned browser capability. Runtime receives structured results only and
 * Renderer never receives Electron objects, cookies, local paths or raw page privileges.
 */
export class BrowserService {
  private readonly engine: BrowserEngine;
  private readonly audit: (event: BrowserAuditEvent) => void;
  private policy: BrowserPolicy;
  private workspaceId: string;

  constructor(options: BrowserServiceOptions = {}) {
    this.audit = options.audit ?? (() => undefined);
    this.policy = structuredClone(options.policy ?? createDefaultRuntimePolicySnapshot().browser);
    this.workspaceId = options.workspaceId ?? 'primary';
    this.engine = options.engine ?? new WebContentsViewBrowserEngine(
      this.audit,
      () => this.policy,
      () => this.workspaceId
    );
  }

  configure(policy: BrowserPolicy, workspaceId: string): void {
    const changedIsolation = policy.sessionMode !== this.policy.sessionMode
      || workspaceId !== this.workspaceId;
    this.policy = structuredClone(policy);
    this.workspaceId = workspaceId;
    if (changedIsolation) this.engine.dispose();
  }

  async handle(operation: BrowserCapabilityOperation): Promise<Record<string, unknown>> {
    try {
      const result = await this.execute(operation);
      const target = operationTarget(operation);
      this.audit({
        operation: operation.kind,
        outcome: 'completed',
        ...(target ? { target } : {})
      });
      return result;
    } catch (error) {
      const target = operationTarget(operation);
      this.audit({
        operation: operation.kind,
        outcome: 'failed',
        ...(target ? { target } : {}),
        detail: publicBrowserError(error)
      });
      throw error;
    }
  }

  dispose(): void {
    this.engine.dispose();
  }

  private async execute(operation: BrowserCapabilityOperation): Promise<Record<string, unknown>> {
    switch (operation.kind) {
      case 'browser.health':
        await this.engine.health();
        return { available: true, isolation: this.policy.sessionMode };
      case 'browser.navigate': {
        const url = requireHttps(operation.url);
        this.requireAllowedOrigin(url);
        this.audit({ operation: operation.kind, outcome: 'allowed', target: redactUrl(url) });
        return this.engine.navigate(url);
      }
      case 'browser.accessibility_snapshot':
        return this.engine.accessibilitySnapshot(MAX_SNAPSHOT_CHARS);
      case 'browser.screenshot': {
        const bytes = await this.engine.screenshot();
        return {
          name: `browser-${Date.now()}.png`,
          mediaType: 'image/png',
          dataBase64: bytes.toString('base64')
        };
      }
      case 'browser.click':
        await this.engine.click(operation.selector);
        return { clicked: true };
      case 'browser.type':
        if (operation.sensitive && !this.policy.allowSensitiveInput) {
          throw new Error('browser_sensitive_input_not_approved');
        }
        if (operation.sensitive) {
          this.audit({
            operation: operation.kind,
            outcome: 'allowed',
            detail: `sensitive_input:${operation.text.length}`
          });
        }
        await this.engine.type(operation.selector, operation.text);
        return { typed: true, sensitive: operation.sensitive, characterCount: operation.text.length };
      case 'browser.scroll':
        await this.engine.scroll(operation.deltaX, operation.deltaY);
        return { scrolled: true };
      case 'browser.wait':
        await this.engine.wait(operation.milliseconds);
        return { waitedMs: operation.milliseconds };
      case 'browser.download': {
        const url = requireHttps(operation.url);
        this.requireAllowedOrigin(url);
        this.audit({ operation: operation.kind, outcome: 'allowed', target: redactUrl(url) });
        const result = await this.engine.download(url, this.policy.maxDownloadBytes);
        return {
          name: result.name,
          mediaType: result.mediaType,
          dataBase64: result.bytes.toString('base64')
        };
      }
    }
  }

  private requireAllowedOrigin(rawUrl: string): void {
    if (this.policy.allowedOrigins.length === 0) return;
    const origin = new URL(rawUrl).origin;
    if (!this.policy.allowedOrigins.some((allowed) => new URL(allowed).origin === origin)) {
      throw new Error('browser_origin_not_allowed');
    }
  }
}

class WebContentsViewBrowserEngine implements BrowserEngine {
  private view: WebContentsView | undefined;
  private approvedOrigin?: string;

  constructor(
    private readonly audit: (event: BrowserAuditEvent) => void,
    private readonly policy: () => BrowserPolicy,
    private readonly workspaceId: () => string
  ) {}

  async health(): Promise<void> {
    this.contents();
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const target = new URL(requireHttps(url));
    this.approvedOrigin = target.origin;
    await this.contents().loadURL(target.toString());
    return { url: this.contents().getURL(), title: this.contents().getTitle() };
  }

  async accessibilitySnapshot(maxChars: number): Promise<{ url: string; title: string; text: string }> {
    const contents = this.contents();
    const text = await contents.executeJavaScript(`
      (() => {
        const limit = ${Math.max(1, Math.min(maxChars, MAX_SNAPSHOT_CHARS))};
        const nodes = [];
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
        let element;
        while ((element = walker.nextNode()) && nodes.join("\\n").length < limit) {
          const role = element.getAttribute("role") || element.tagName.toLowerCase();
          const label = element.getAttribute("aria-label")
            || element.getAttribute("alt")
            || element.getAttribute("title")
            || element.innerText
            || "";
          const normalized = String(label).replace(/\\s+/g, " ").trim().slice(0, 500);
          if (normalized) nodes.push(role + ": " + normalized);
        }
        return nodes.join("\\n").slice(0, limit);
      })()
    `, true) as string;
    return { url: contents.getURL(), title: contents.getTitle(), text };
  }

  async screenshot(): Promise<Buffer> {
    return (await this.contents().capturePage()).toPNG();
  }

  async click(selector: string): Promise<void> {
    const clicked = await this.contents().executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return false;
        element.click();
        return true;
      })()
    `, true) as boolean;
    if (!clicked) throw new Error('browser_selector_not_found');
  }

  async type(selector: string, text: string): Promise<void> {
    const typed = await this.contents().executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLInputElement)
          && !(element instanceof HTMLTextAreaElement)
          && !(element instanceof HTMLElement && element.isContentEditable)) return false;
        element.focus();
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = ${JSON.stringify(text)};
        } else {
          element.textContent = ${JSON.stringify(text)};
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `, true) as boolean;
    if (!typed) throw new Error('browser_selector_not_typeable');
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.contents().executeJavaScript(
      `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
      true
    );
  }

  async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
  }

  async download(
    url: string,
    maxBytes: number
  ): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
    const target = new URL(requireHttps(url));
    const response = await this.browserSession().fetch(target.toString(), { redirect: 'error' });
    if (!response.ok) throw new Error(`browser_download_http_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error('browser_download_too_large');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('browser_download_too_large');
    return {
      bytes,
      mediaType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
      name: safeDownloadName(target)
    };
  }

  dispose(): void {
    this.view?.webContents.close({ waitForBeforeUnload: false });
    this.view = undefined;
  }

  private contents(): WebContents {
    if (!this.view) {
      const partition = this.policy().sessionMode === 'workspace-persistent'
        ? `persist:ariadne-browser-${workspacePartitionId(this.workspaceId())}`
        : `ariadne-browser-${randomUUID()}`;
      this.view = new WebContentsView({
        webPreferences: {
          partition,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          spellcheck: false
        }
      });
      const contents = this.view.webContents;
      contents.setWindowOpenHandler(({ url }) => {
        this.audit({
          operation: 'browser.navigate',
          outcome: 'blocked',
          target: redactUrl(url),
          detail: 'popup_denied'
        });
        return { action: 'deny' };
      });
      contents.on('will-navigate', (event, url) => {
        if (this.navigationAllowed(url)) return;
        event.preventDefault();
        this.audit({
          operation: 'browser.navigate',
          outcome: 'blocked',
          target: redactUrl(url),
          detail: 'navigation_policy_denied'
        });
      });
      contents.on('will-redirect', (event, url) => {
        if (this.navigationAllowed(url)) return;
        event.preventDefault();
        this.audit({
          operation: 'browser.navigate',
          outcome: 'blocked',
          target: redactUrl(url),
          detail: 'cross_origin_redirect_denied'
        });
      });
      const browserSession = contents.session;
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      browserSession.on('will-download', (event, item) => {
        event.preventDefault();
        this.audit({
          operation: 'browser.download',
          outcome: 'blocked',
          target: redactUrl(item.getURL()),
          detail: 'unapproved_download_denied'
        });
      });
    }
    return this.view.webContents;
  }

  private browserSession(): Session {
    return this.contents().session;
  }

  private navigationAllowed(url: string): boolean {
    try {
      const target = new URL(url);
      return target.protocol === 'https:' && target.origin === this.approvedOrigin;
    } catch {
      return false;
    }
  }
}

function requireHttps(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('browser_https_required');
  if (url.username || url.password) throw new Error('browser_url_credentials_denied');
  return url.toString();
}

function safeDownloadName(url: URL): string {
  const candidate = decodeURIComponent(url.pathname.split('/').at(-1) || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .slice(0, 180);
  return candidate || 'download';
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function operationTarget(operation: BrowserCapabilityOperation): string | undefined {
  return 'url' in operation ? redactUrl(operation.url) : undefined;
}

function publicBrowserError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : 'browser_operation_failed';
}

function workspacePartitionId(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
}
