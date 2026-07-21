import { describe, expect, it } from 'vitest';
import {
  clipboardWriteRequestSchema,
  closeTerminalRequestSchema,
  createTerminalSessionRequestSchema,
  resizeTerminalRequestSchema,
  saveLayoutRequestSchema,
  showWindowRequestSchema,
  titleBarThemeSchema,
  userPreferencesSchema,
  writeTerminalRequestSchema
} from '@shared/schemas';

describe('IPC schemas', () => {
  it('accepts bounded clipboard text and rejects invalid payloads', () => {
    expect(clipboardWriteRequestSchema.safeParse({ text: 'copy me' }).success).toBe(true);
    expect(clipboardWriteRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(clipboardWriteRequestSchema.safeParse({ text: 'x'.repeat(256 * 1024 + 1) }).success).toBe(false);
    expect(clipboardWriteRequestSchema.safeParse({ text: 'copy me', format: 'html' }).success).toBe(false);
  });

  it('accepts a JSON Dockview payload and rejects non-JSON values', () => {
    expect(saveLayoutRequestSchema.safeParse({ layout: { panels: {}, width: 1200 } }).success).toBe(true);
    expect(saveLayoutRequestSchema.safeParse({ layout: { invalid: undefined } }).success).toBe(false);
    expect(saveLayoutRequestSchema.safeParse({ layout: {}, extra: true }).success).toBe(false);
  });

  it('rejects unknown wake sources and unknown preference keys', () => {
    expect(showWindowRequestSchema.safeParse({ source: 'remote', allowTemporaryTopmost: true }).success).toBe(false);
    expect(userPreferencesSchema.safeParse({
      runInBackground: true,
      startAtLogin: false,
      theme: 'dark',
      suppressAutomaticWakeDuringGames: true,
      gameDetectionRules: [],
      arbitraryFileAccess: true
    }).success).toBe(false);
    expect(titleBarThemeSchema.safeParse('system').success).toBe(false);
    expect(titleBarThemeSchema.safeParse('light').success).toBe(true);
  });

  it('only accepts bounded PowerShell and CMD terminal requests', () => {
    const sessionId = '8a74a717-d9c7-4a09-a038-83c138362f1e';
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, shell: 'powershell', columns: 120, rows: 30 }).success).toBe(true);
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, shell: 'cmd', columns: 80, rows: 24 }).success).toBe(true);
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, shell: 'bash', columns: 80, rows: 24 }).success).toBe(false);
    expect(resizeTerminalRequestSchema.safeParse({ sessionId, columns: 501, rows: 24 }).success).toBe(false);
    expect(writeTerminalRequestSchema.safeParse({ sessionId, data: 'dir\r' }).success).toBe(true);
    expect(writeTerminalRequestSchema.safeParse({ sessionId, data: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(closeTerminalRequestSchema.safeParse({ sessionId, extra: true }).success).toBe(false);
  });
});
