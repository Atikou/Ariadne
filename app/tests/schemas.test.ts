import { describe, expect, it } from 'vitest';
import {
  agentSettingsMutationSchema,
  clipboardWriteRequestSchema,
  closeTerminalRequestSchema,
  createTerminalSessionRequestSchema,
  resizeTerminalRequestSchema,
  runtimeDesktopRequestSchema,
  runtimeRequestResultSchema,
  runtimeStatusResultSchema,
  saveLayoutRequestSchema,
  showWindowRequestSchema,
  titleBarThemeSchema,
  userPreferencesSchema,
  workspaceDirectoryRequestSchema,
  writeTerminalRequestSchema
} from '@shared/schemas';

describe('IPC schemas', () => {
  it('requires structured Runtime results and bounded public errors', () => {
    expect(runtimeDesktopRequestSchema.safeParse({
      commandId: 'renderer-command-1',
      command: { kind: 'runtime.status.get' }
    }).success).toBe(true);
    expect(runtimeDesktopRequestSchema.safeParse({
      commandId: '',
      command: { kind: 'runtime.status.get' }
    }).success).toBe(false);
    expect(runtimeDesktopRequestSchema.safeParse({
      kind: 'runtime.status.get'
    }).success).toBe(false);
    expect(runtimeStatusResultSchema.safeParse({
      ok: true,
      value: {
        availability: 'ready',
        capabilities: [],
        observedAt: new Date().toISOString()
      }
    }).success).toBe(true);
    expect(runtimeRequestResultSchema.safeParse({
      ok: false,
      error: {
        code: 'command_outcome_uncertain',
        message: 'Outcome must be reconciled.',
        retryable: false,
        correlationId: 'command-1'
      }
    }).success).toBe(true);
    expect(runtimeRequestResultSchema.safeParse({
      ok: false,
      error: {
        code: 'INVALID CODE',
        message: 'bad',
        retryable: true,
        correlationId: 'command-1'
      }
    }).success).toBe(false);
    expect(runtimeRequestResultSchema.safeParse({
      kind: 'runtime.status',
      status: {
        availability: 'ready',
        capabilities: [],
        observedAt: new Date().toISOString()
      }
    }).success).toBe(false);
  });

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
      expectedRevision: 7,
      operations: [{
        kind: 'provider.update',
        providerId: 'openai',
        patch: {
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-test',
          inference: {},
          apiKey: 'test-api-key'
        }
      }]
    };
    expect(agentSettingsMutationSchema.safeParse(valid).success).toBe(true);
    expect(agentSettingsMutationSchema.safeParse({
      ...valid,
      operations: [{
        ...valid.operations[0],
        patch: { ...valid.operations[0]!.patch, baseUrl: 'http://api.example.com/v1' }
      }]
    }).success).toBe(false);
    expect(agentSettingsMutationSchema.safeParse({
      ...valid,
      operations: [{
        ...valid.operations[0],
        patch: { ...valid.operations[0]!.patch, clearApiKey: true }
      }]
    }).success).toBe(false);
    expect(agentSettingsMutationSchema.safeParse({
      expectedRevision: 7,
      operations: [
        { kind: 'permissions.set', mode: 'request' },
        { kind: 'permissions.set', mode: 'risk-based' }
      ]
    }).success).toBe(false);
    expect(agentSettingsMutationSchema.safeParse({
      ...valid,
      routingStrategy: 'cloud-first'
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
