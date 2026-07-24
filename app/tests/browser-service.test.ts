import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';

vi.mock('electron', () => ({
  WebContentsView: class {
    constructor() {
      throw new Error('real_electron_browser_must_not_start_in_unit_test');
    }
  }
}));

import {
  BrowserService,
  type BrowserAuditEvent,
  type BrowserEngine
} from '../src/main/services/browser-service';

class FakeBrowserEngine implements BrowserEngine {
  calls: Array<{ operation: string; value?: unknown }> = [];

  async health(): Promise<void> {
    this.calls.push({ operation: 'health' });
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    this.calls.push({ operation: 'navigate', value: url });
    return { url, title: 'Test page' };
  }

  async accessibilitySnapshot(): Promise<{ url: string; title: string; text: string }> {
    return { url: 'https://example.test/', title: 'Test page', text: 'button: Continue' };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('png');
  }

  async click(selector: string): Promise<void> {
    this.calls.push({ operation: 'click', value: selector });
  }

  async type(selector: string, text: string): Promise<void> {
    this.calls.push({ operation: 'type', value: { selector, text } });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    this.calls.push({ operation: 'scroll', value: { deltaX, deltaY } });
  }

  async wait(milliseconds: number): Promise<void> {
    this.calls.push({ operation: 'wait', value: milliseconds });
  }

  async download(url: string): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
    this.calls.push({ operation: 'download', value: url });
    return { bytes: Buffer.from('payload'), mediaType: 'text/plain', name: 'file.txt' };
  }

  dispose(): void {
    this.calls.push({ operation: 'dispose' });
  }
}

describe('Main Browser capability policy', () => {
  let engine: FakeBrowserEngine;
  let audit: BrowserAuditEvent[];
  let service: BrowserService;

  beforeEach(() => {
    engine = new FakeBrowserEngine();
    audit = [];
    service = new BrowserService({ engine, audit: (event) => audit.push(event) });
  });

  it('publishes health only after the isolated engine responds', async () => {
    await expect(service.handle({ kind: 'browser.health' })).resolves.toEqual({
      available: true,
      isolation: 'temporary'
    });
    expect(engine.calls).toEqual([{ operation: 'health' }]);
  });

  it('rejects HTTP and credential-bearing URLs before navigation or download', async () => {
    await expect(service.handle({
      kind: 'browser.navigate',
      url: 'http://example.test/'
    })).rejects.toThrow('browser_https_required');
    await expect(service.handle({
      kind: 'browser.download',
      url: 'https://user:secret@example.test/file'
    })).rejects.toThrow('browser_url_credentials_denied');
    expect(engine.calls).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  it('does not echo sensitive typed text into results or audit records', async () => {
    service.configure({
      ...createDefaultRuntimePolicySnapshot().browser,
      allowSensitiveInput: true
    }, 'primary');
    const result = await service.handle({
      kind: 'browser.type',
      selector: '#password',
      text: 'private-value',
      sensitive: true
    });

    expect(result).toEqual({ typed: true, sensitive: true, characterCount: 13 });
    expect(JSON.stringify(audit)).not.toContain('private-value');
  });

  it('requires explicit policy approval before sensitive input', async () => {
    await expect(service.handle({
      kind: 'browser.type',
      selector: '#password',
      text: 'private-value',
      sensitive: true
    })).rejects.toThrow('browser_sensitive_input_not_approved');
    expect(engine.calls).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain('private-value');
  });

  it('returns screenshots and downloads as bounded IPC payloads for Runtime registration', async () => {
    await expect(service.handle({ kind: 'browser.screenshot' })).resolves.toMatchObject({
      mediaType: 'image/png',
      dataBase64: Buffer.from('png').toString('base64')
    });
    await expect(service.handle({
      kind: 'browser.download',
      url: 'https://example.test/file.txt'
    })).resolves.toEqual({
      name: 'file.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('payload').toString('base64')
    });
  });
});
