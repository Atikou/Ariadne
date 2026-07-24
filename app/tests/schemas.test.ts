import { describe, expect, it } from 'vitest';
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

  it('accepts supported Agent providers and rejects unsafe model settings', () => {
    const valid = {
      routingStrategy: 'cloud-first',
      permissionMode: 'request',
      customPermissions: {
        approvalPolicy: 'risk-based',
        sandboxMode: 'workspace-write',
        allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
      },
      workspaceRoot: 'E:\\Project\\Ariadne',
      workspaceAccess: 'write',
      localModelRoots: ['D:\\Models'],
      providers: {
        openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', inference: {}, apiKey: 'test-api-key', clearApiKey: false },
        deepseek: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-test', inference: { reasoning: { modes: ['off', 'on'], defaultMode: 'on', efforts: ['high', 'max'], defaultEffort: 'high' } }, clearApiKey: false },
        kimi: { enabled: true, baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', inference: { reasoning: { modes: ['on'], defaultMode: 'on', efforts: ['low', 'high', 'max'], defaultEffort: 'max' } }, clearApiKey: false },
        anthropic: { enabled: false, baseUrl: 'https://api.anthropic.com', model: 'claude-test', inference: {}, clearApiKey: false }
      }
    };
    expect(agentSettingsUpdateSchema.safeParse(valid).success).toBe(true);
    expect(agentSettingsUpdateSchema.safeParse({
      ...valid,
      providers: {
        ...valid.providers,
        openai: { ...valid.providers.openai, baseUrl: 'http://api.example.com/v1' }
      }
    }).success).toBe(false);
    expect(agentSettingsUpdateSchema.safeParse({
      ...valid,
      providers: {
        ...valid.providers,
        openai: { ...valid.providers.openai, clearApiKey: true }
      }
    }).success).toBe(false);
  });

  it('only accepts bounded PowerShell and CMD terminal requests', () => {
    const sessionId = '8a74a717-d9c7-4a09-a038-83c138362f1e';
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, workspaceId: 'primary', shell: 'powershell', columns: 120, rows: 30 }).success).toBe(true);
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, workspaceId: 'workspace-secondary', shell: 'cmd', columns: 80, rows: 24 }).success).toBe(true);
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, workspaceId: 'primary', shell: 'bash', columns: 80, rows: 24 }).success).toBe(false);
    expect(createTerminalSessionRequestSchema.safeParse({ sessionId, shell: 'cmd', columns: 80, rows: 24 }).success).toBe(false);
    expect(resizeTerminalRequestSchema.safeParse({ sessionId, columns: 501, rows: 24 }).success).toBe(false);
    expect(writeTerminalRequestSchema.safeParse({ sessionId, data: 'dir\r' }).success).toBe(true);
    expect(writeTerminalRequestSchema.safeParse({ sessionId, data: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(closeTerminalRequestSchema.safeParse({ sessionId, extra: true }).success).toBe(false);
  });

  it('requires an explicit workspace identity for directory access', () => {
    expect(workspaceDirectoryRequestSchema.safeParse({
      workspaceId: 'workspace-secondary',
      relativePath: 'src/components'
    }).success).toBe(true);
    expect(workspaceDirectoryRequestSchema.safeParse({ relativePath: 'src' }).success).toBe(false);
    expect(workspaceDirectoryRequestSchema.safeParse({
      workspaceId: 'workspace-secondary',
      relativePath: '../outside'
    }).success).toBe(false);
  });
});
