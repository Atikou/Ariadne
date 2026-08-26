import type {
  AgentJsonValue,
  AgentPersistencePayloadContext
} from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import { StrictJsonAgentPersistencePayloadCodec } from '../src/adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';

const context: AgentPersistencePayloadContext = {
  kind: 'checkpoint',
  runId: 'run-codec-test',
  commandId: 'command-codec-test',
  runVersion: 2,
  checkpointVersion: 1
};

describe('StrictJsonAgentPersistencePayloadCodec', () => {
  it('round-trips bounded ordinary nested JSON', () => {
    const codec = new StrictJsonAgentPersistencePayloadCodec();
    const value: AgentJsonValue = {
      messages: [{ role: 'user', content: 'Please inspect src/result.ts.' }],
      continuation: { turn: 3, toolCalls: [] }
    };

    const encoded = codec.encode(value, context);
    expect(encoded.codecId).toBe('strict-json-v1');
    expect(codec.decode(encoded, context)).toEqual(value);
  });

  it.each([
    ['cloud access key', `prefix AKIA${'A'.repeat(16)} suffix`],
    ['GitHub token', `nested ghp_${'a'.repeat(24)} value`],
    ['API token', `message contains sk-${'b'.repeat(24)}`],
    ['authorization', `Bearer ${'c'.repeat(24)}`],
    ['private key', '-----BEGIN PRIVATE KEY-----']
  ])('rejects %s patterns even in an ordinary nested message field', (_label, secret) => {
    const codec = new StrictJsonAgentPersistencePayloadCodec();
    expect(() => codec.encode({ nested: { message: secret } }, context))
      .toThrowError(expect.objectContaining({
        code: 'AGENT_PERSISTENCE_PAYLOAD_REJECTED'
      }));
  });

  it('rejects sensitive field names at arbitrary depth without returning the value', () => {
    const codec = new StrictJsonAgentPersistencePayloadCodec();
    expect(() => codec.encode({ outer: { Headers: { Authorization: 'redacted' } } }, context))
      .toThrowError(/credentials and raw authorization/);
  });

  it.each([
    ['token', { token: 'opaqueCredentialValue0123456789' }],
    ['authToken', { authToken: 'opaqueCredentialValue0123456789' }],
    ['X-Api-Key', { headers: { 'X-Api-Key': 'opaqueCredentialValue0123456789' } }]
  ])('rejects the common %s credential field', (_label, value) => {
    const codec = new StrictJsonAgentPersistencePayloadCodec();
    expect(() => codec.encode(value, context)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PERSISTENCE_PAYLOAD_REJECTED' })
    );
  });

  it('rejects cyclic, non-finite, and oversized payloads', () => {
    const codec = new StrictJsonAgentPersistencePayloadCodec();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => codec.encode(cyclic as AgentJsonValue, context)).toThrow();
    expect(() => codec.encode({ value: Number.NaN } as AgentJsonValue, context)).toThrow();
    expect(() => codec.encode({ value: 'x'.repeat(256 * 1024) }, context))
      .toThrow(/256 KiB/);
  });
});
