import { randomBytes } from 'node:crypto';

import {
  AgentPersistencePayloadRejectedError,
  type AgentJsonValue,
  type AgentPersistencePayloadContext,
  type EncodedAgentPersistencePayload
} from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import {
  AesGcmAgentPersistencePayloadCodec
} from '../src/adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';

const context: AgentPersistencePayloadContext = {
  kind: 'checkpoint',
  runId: 'run-1',
  commandId: 'command-1',
  runVersion: 2,
  checkpointVersion: 1
};

const turnInputContext: AgentPersistencePayloadContext = {
  kind: 'turn_input',
  runId: 'run-1',
  turnId: 'turn-1',
  commandId: 'command-1',
  runVersion: 2,
  inputDigest: `sha256:${'a'.repeat(64)}`
};

describe('AesGcmAgentPersistencePayloadCodec', () => {
  it('round-trips safe recovery JSON without exposing plaintext', () => {
    const key = randomBytes(32);
    const codec = new AesGcmAgentPersistencePayloadCodec(
      'key-2026-07',
      [{ keyId: 'key-2026-07', key }]
    );
    const value = {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: { step: 3 },
      modelContext: { privateWorkspaceText: 'not-visible-in-the-database' }
    } as const;

    const encoded = codec.encode(value, context);

    expect(encoded.codecId).toBe('aes-256-gcm-v1');
    expect(JSON.stringify(encoded.payload)).not.toContain(
      'not-visible-in-the-database'
    );
    expect(codec.decode(encoded, context)).toEqual(value);

    codec.destroy();
    key.fill(0);
  });

  it.each([
    ['ciphertext', (envelope: Record<string, AgentJsonValue>) => {
      envelope.ciphertext = flipBase64Byte(String(envelope.ciphertext));
    }],
    ['nonce', (envelope: Record<string, AgentJsonValue>) => {
      envelope.nonce = flipBase64Byte(String(envelope.nonce));
    }],
    ['authentication tag', (envelope: Record<string, AgentJsonValue>) => {
      envelope.authenticationTag = flipBase64Byte(
        String(envelope.authenticationTag)
      );
    }]
  ])('rejects a modified %s', (_label, mutate) => {
    const codec = createCodec('active');
    const encoded = codec.encode({ value: 'ordinary text' }, context);
    const envelope = structuredClone(encoded.payload) as Record<string, AgentJsonValue>;
    mutate(envelope);

    expect(() => codec.decode({
      codecId: encoded.codecId,
      payload: envelope
    }, context)).toThrow(AgentPersistencePayloadRejectedError);
    codec.destroy();
  });

  it('authenticates the exact aggregate and command metadata as AAD', () => {
    const codec = createCodec('active');
    const encoded = codec.encode({ value: 'ordinary text' }, context);

    expect(() => codec.decode(encoded, {
      ...context,
      commandId: 'a-different-command'
    })).toThrow(AgentPersistencePayloadRejectedError);
    expect(() => codec.decode(encoded, {
      ...context,
      runVersion: 3
    })).toThrow(AgentPersistencePayloadRejectedError);
    codec.destroy();
  });

  it('requires canonical Turn and lowercase SHA-256 identities for Turn-input AAD', () => {
    const codec = createCodec('active');
    expect(() => codec.encode({ value: 'ordinary text' }, {
      ...turnInputContext,
      inputDigest: undefined
    })).toThrow(/canonical Turn and input-digest identities/u);
    expect(() => codec.encode({ value: 'ordinary text' }, {
      ...turnInputContext,
      inputDigest: `sha256:${'A'.repeat(64)}`
    })).toThrow(/canonical Turn and input-digest identities/u);
    expect(() => codec.encode({ value: 'ordinary text' }, {
      ...turnInputContext,
      turnId: ' turn-1 '
    })).toThrow(/canonical Turn and input-digest identities/u);
    codec.destroy();
  });

  it('authenticates exact Turn and input-digest identities for Turn-input payloads', () => {
    const codec = createCodec('active');
    const encoded = codec.encode({ value: 'ordinary text' }, turnInputContext);

    expect(() => codec.decode(encoded, {
      ...turnInputContext,
      turnId: 'turn-2'
    })).toThrow(/authentication failed/u);
    expect(() => codec.decode(encoded, {
      ...turnInputContext,
      inputDigest: `sha256:${'b'.repeat(64)}`
    })).toThrow(/authentication failed/u);
    codec.destroy();
  });

  it('preserves the fixed legacy checkpoint AAD byte representation', () => {
    const codec = new AesGcmAgentPersistencePayloadCodec(
      'golden-key',
      [{ keyId: 'golden-key', key: Buffer.alloc(32, 41) }],
      () => Buffer.alloc(12, 7)
    );

    expect(codec.encode({ value: 'legacy-golden' }, context)).toEqual({
      codecId: 'aes-256-gcm-v1',
      payload: {
        schemaVersion: 1,
        algorithm: 'A256GCM',
        keyId: 'golden-key',
        nonce: 'BwcHBwcHBwcHBwcH',
        ciphertext: '+J7tsC8AljVsFpUJBZuLGNY5I/vm0HhSLA==',
        authenticationTag: 'U3itSNCKF+GfNiFOahSGLw=='
      }
    });
    codec.destroy();
  });

  it('authenticates protected envelope metadata including the key id', () => {
    const codec = new AesGcmAgentPersistencePayloadCodec('active', [
      { keyId: 'active', key: Buffer.alloc(32, 11) },
      { keyId: 'alternate', key: Buffer.alloc(32, 12) }
    ]);
    const encoded = codec.encode({ value: 'ordinary text' }, context);
    const envelope = structuredClone(encoded.payload) as Record<string, AgentJsonValue>;
    envelope.keyId = 'alternate';

    expect(() => codec.decode({
      codecId: encoded.codecId,
      payload: envelope
    }, context)).toThrow(/authentication failed/u);
    codec.destroy();
  });

  it('rejects key-material reuse under a different key id', () => {
    const repeatedMaterial = Buffer.alloc(32, 23);

    expect(() => new AesGcmAgentPersistencePayloadCodec('first', [
      { keyId: 'first', key: repeatedMaterial },
      { keyId: 'second', key: repeatedMaterial }
    ])).toThrow(/reuse key material/u);

    repeatedMaterial.fill(0);
  });

  it('fails closed when construction fails after copying an earlier key', () => {
    const valid = Buffer.alloc(32, 31);
    const malformed = Buffer.alloc(31, 32);
    const bufferConstructor = Buffer as unknown as {
      from: (...arguments_: unknown[]) => Buffer;
    };
    const originalFrom = bufferConstructor.from;
    let privateCopy: Buffer | undefined;
    bufferConstructor.from = (...arguments_) => {
      const copy = Reflect.apply(originalFrom, Buffer, arguments_) as Buffer;
      if (arguments_[0] === valid) privateCopy = copy;
      return copy;
    };
    try {
      expect(() => new AesGcmAgentPersistencePayloadCodec('valid', [
        { keyId: 'valid', key: valid },
        { keyId: 'malformed', key: malformed }
      ])).toThrow(/must contain 32 bytes/u);
    } finally {
      bufferConstructor.from = originalFrom;
    }

    expect(privateCopy).toBeDefined();
    expect(privateCopy!.every((byte) => byte === 0)).toBe(true);
    // Source buffers remain caller-owned and are not destroyed by the codec.
    expect(valid).toEqual(Buffer.alloc(32, 31));
    expect(malformed).toEqual(Buffer.alloc(31, 32));
    valid.fill(0);
    malformed.fill(0);
  });

  it('reads decrypt-only keys while writing only with the active key', () => {
    const oldKey = Buffer.alloc(32, 17);
    const newKey = Buffer.alloc(32, 29);
    const oldCodec = new AesGcmAgentPersistencePayloadCodec(
      'old',
      [{ keyId: 'old', key: oldKey }]
    );
    const oldPayload = oldCodec.encode({ generation: 'old' }, context);
    oldCodec.destroy();

    const rotated = new AesGcmAgentPersistencePayloadCodec('new', [
      { keyId: 'new', key: newKey },
      { keyId: 'old', key: oldKey }
    ]);
    const newPayload = rotated.encode({ generation: 'new' }, context);

    expect(rotated.decode(oldPayload, context)).toEqual({ generation: 'old' });
    expect(rotated.decode(newPayload, context)).toEqual({ generation: 'new' });
    expect(newPayload.payload).toMatchObject({ keyId: 'new' });

    rotated.destroy();
    oldKey.fill(0);
    newKey.fill(0);
  });

  it('fails closed for unknown keys, malformed envelopes, and raw credentials', () => {
    const codec = createCodec('active');
    const encoded = codec.encode({ value: 'ordinary text' }, context);
    const unknownKey = structuredClone(encoded.payload) as Record<string, AgentJsonValue>;
    unknownKey.keyId = 'missing';

    expect(() => codec.decode({
      codecId: encoded.codecId,
      payload: unknownKey
    }, context)).toThrow(/unavailable/u);
    expect(() => codec.decode({
      codecId: encoded.codecId,
      payload: {
        ...(encoded.payload as Record<string, AgentJsonValue>),
        unexpected: true
      }
    }, context)).toThrow(/unexpected fields/u);
    expect(() => codec.encode({
      authorization: 'Bearer definitely-sensitive-token'
    }, context)).toThrow(AgentPersistencePayloadRejectedError);
    codec.destroy();
  });

  it('cannot be reused after key material is destroyed', () => {
    const codec = createCodec('active');
    const encoded = codec.encode({ value: 'ordinary text' }, context);
    codec.destroy();

    expect(() => codec.encode({ value: 'new' }, context)).toThrow(/destroyed/u);
    expect(() => codec.decode(encoded, context)).toThrow(/destroyed/u);
  });
});

function createCodec(keyId: string): AesGcmAgentPersistencePayloadCodec {
  return new AesGcmAgentPersistencePayloadCodec(
    keyId,
    [{ keyId, key: Buffer.alloc(32, 41) }]
  );
}

function flipBase64Byte(value: string): string {
  const decoded = Buffer.from(value, 'base64');
  decoded[0] = (decoded[0] ?? 0) ^ 1;
  return decoded.toString('base64');
}
