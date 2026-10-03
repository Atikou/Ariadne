import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveModelCapabilities,
  unknownQualification
} from '../src/model/capability/ModelCapabilityQualification.js';
import {
  ModelCapabilityRegistry
} from '../src/model/capability/ModelCapabilityRegistry.js';
import { LocalTextCapabilityProbe } from '../src/model/capability/LocalTextCapabilityProbe.js';
import type { ModelClient } from '../src/model/types.js';

const roots: string[] = [];
const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ModelCapabilityRegistry', () => {
  it('persists exact-fingerprint qualification and invalidates it on fingerprint change', () => {
    const databasePath = temporaryDatabase();
    const first = new ModelCapabilityRegistry(databasePath);
    first.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_A);
    first.write({
      ...unknownQualification({
        providerId: 'ariadne.local',
        modelId: 'qwen',
        fingerprint: FINGERPRINT_A
      }),
      textResponse: 'qualified',
      testedAt: '2032-01-01T00:00:00.000Z'
    });
    expect(deriveModelCapabilities(first.current('ariadne.local', 'qwen')!))
      .toMatchObject({ supportsTextChat: true, supportsAgent: false, supportsPlan: false });
    first.close();

    const reopened = new ModelCapabilityRegistry(databasePath);
    reopened.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_A);
    expect(reopened.current('ariadne.local', 'qwen')?.textResponse).toBe('qualified');
    reopened.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_B);
    expect(reopened.current('ariadne.local', 'qwen')?.textResponse).toBe('unknown');
    reopened.close();
  });

  it('qualifies non-empty plain text without granting Agent or Plan', async () => {
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const chat = vi.fn(async (request: Parameters<ModelClient['chat']>[0]) => {
      request.onToken?.('一加一等于二。');
      return {
        content: '一加一等于二。',
        toolCalls: [],
        clientName: 'qwen',
        modelName: 'Qwen',
        location: 'local' as const,
        latencyMs: 1
      };
    });
    const probe = new LocalTextCapabilityProbe(registry);
    const report = await probe.run({
      providerId: 'ariadne.local',
      modelId: 'qwen',
      fingerprint: FINGERPRINT_A,
      client: modelClient(chat)
    });

    expect(chat).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      textResponse: 'qualified',
      streamingText: 'qualified',
      exactTokenizer: 'qualified',
      nativeToolCalls: 'rejected'
    });
    expect(deriveModelCapabilities(report)).toEqual({
      supportsTextChat: true,
      supportsAgent: false,
      supportsPlan: false,
      supportsVision: false,
      qualificationState: 'qualified'
    });
    registry.close();
  });

  it('rejects an empty response instead of interpreting it or granting a capability', async () => {
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const probe = new LocalTextCapabilityProbe(registry);
    const report = await probe.run({
      providerId: 'ariadne.local',
      modelId: 'empty',
      fingerprint: FINGERPRINT_A,
      client: modelClient(async () => ({
        content: '   ',
        toolCalls: [],
        clientName: 'empty',
        modelName: 'Empty',
        location: 'local',
        latencyMs: 1
      }))
    });

    expect(report.textResponse).toBe('rejected');
    expect(report.failureCode).toBe('model_response_empty');
    expect(deriveModelCapabilities(report).supportsTextChat).toBe(false);
    registry.close();
  });
});

function modelClient(chat: ModelClient['chat']): ModelClient {
  return {
    name: 'qwen',
    model: 'Qwen',
    location: 'local',
    toolCallCapability: 'unsupported',
    contextWindowTokens: 32_768,
    isAvailable: async () => true,
    chat,
    tokenCounter: {
      profile: 'test',
      exact: true,
      countText: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countMessages: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countTools: async () => ({
        tokens: 0,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countRequest: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      })
    }
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-model-capability-'));
  roots.push(root);
  return path.join(root, 'model-capability.db');
}
