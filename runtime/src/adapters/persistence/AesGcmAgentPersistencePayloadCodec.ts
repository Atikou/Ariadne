import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import {
  AgentPersistencePayloadRejectedError,
  type AgentJsonValue,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext,
  type EncodedAgentPersistencePayload
} from '@ariadne/agent-core';

import { StrictJsonAgentPersistencePayloadCodec } from './StrictJsonAgentPersistencePayloadCodec.js';

export const AES_GCM_AGENT_PERSISTENCE_CODEC_ID = 'aes-256-gcm-v1';
const CODEC_ID = AES_GCM_AGENT_PERSISTENCE_CODEC_ID;
const ALGORITHM = 'A256GCM';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENCODED_COMPONENT_BYTES = 384 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface AgentPersistenceDataKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

interface EncryptedPayloadEnvelope {
  readonly schemaVersion: 1;
  readonly algorithm: typeof ALGORITHM;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

/**
 * Authenticated production codec for Agent recovery material.
 *
 * Key material is copied into this instance and can be zeroed with `destroy`.
 * Callers must still own the lifecycle of the source buffers they supplied.
 */
export class AesGcmAgentPersistencePayloadCodec
implements AgentPersistencePayloadCodec {
  private readonly keys = new Map<string, Buffer>();
  private readonly validator = new StrictJsonAgentPersistencePayloadCodec();
  private destroyed = false;

  public constructor(
    private readonly activeKeyId: string,
    dataKeys: readonly AgentPersistenceDataKey[],
    private readonly nonceSource: (size: number) => Buffer = randomBytes
  ) {
    try {
      assertKeyId(activeKeyId);
      if (dataKeys.length === 0) {
        throw rejected('Agent persistence key ring is empty.');
      }
      for (const dataKey of dataKeys) {
        assertKeyId(dataKey.keyId);
        if (dataKey.key.byteLength !== KEY_BYTES) {
          throw rejected(`Agent persistence key ${dataKey.keyId} must contain 32 bytes.`);
        }
        if (this.keys.has(dataKey.keyId)) {
          throw rejected(`Agent persistence key ${dataKey.keyId} is duplicated.`);
        }

        const copiedKey = Buffer.from(dataKey.key);
        try {
          for (const [existingKeyId, existingKey] of this.keys) {
            if (timingSafeEqual(existingKey, copiedKey)) {
              throw rejected(
                `Agent persistence keys ${existingKeyId} and ${dataKey.keyId} reuse key material.`
              );
            }
          }
          this.keys.set(dataKey.keyId, copiedKey);
        } catch (error) {
          copiedKey.fill(0);
          throw error;
        }
      }
      if (!this.keys.has(activeKeyId)) {
        throw rejected('The active Agent persistence key is unavailable.');
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  public encode(
    value: AgentJsonValue,
    context: AgentPersistencePayloadContext
  ): EncodedAgentPersistencePayload {
    this.assertUsable();
    const activeKey = this.keys.get(this.activeKeyId);
    if (!activeKey) throw rejected('The active Agent persistence key is unavailable.');

    const validated = this.validator.encode(value, context).payload;
    const plaintext = Buffer.from(JSON.stringify(validated), 'utf8');
    let nonce: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      nonce = this.nonceSource(NONCE_BYTES);
      if (nonce.byteLength !== NONCE_BYTES) {
        throw rejected('The Agent persistence nonce source returned an invalid nonce.');
      }
      const cipher = createCipheriv('aes-256-gcm', activeKey, nonce, {
        authTagLength: TAG_BYTES
      });
      cipher.setAAD(createAdditionalAuthenticatedData(context, this.activeKeyId));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      return {
        codecId: CODEC_ID,
        payload: {
          schemaVersion: 1,
          algorithm: ALGORITHM,
          keyId: this.activeKeyId,
          nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          authenticationTag: authenticationTag.toString('base64')
        }
      };
    } catch (error) {
      if (error instanceof AgentPersistencePayloadRejectedError) throw error;
      throw rejected('Agent recovery payload encryption failed.');
    } finally {
      plaintext.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
    }
  }

  public decode(
    encoded: EncodedAgentPersistencePayload,
    context: AgentPersistencePayloadContext
  ): AgentJsonValue {
    this.assertUsable();
    if (encoded.codecId !== CODEC_ID) {
      throw rejected('The persisted Agent payload requires an unavailable codec.');
    }
    const envelope = parseEnvelope(encoded.payload);
    const key = this.keys.get(envelope.keyId);
    if (!key) {
      throw rejected(`Agent persistence key ${envelope.keyId} is unavailable.`);
    }

    const nonce = decodeBase64(envelope.nonce, NONCE_BYTES, 'nonce');
    const ciphertext = decodeBase64(
      envelope.ciphertext,
      undefined,
      'ciphertext'
    );
    const authenticationTag = decodeBase64(
      envelope.authenticationTag,
      TAG_BYTES,
      'authentication tag'
    );
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
        authTagLength: TAG_BYTES
      });
      decipher.setAAD(createAdditionalAuthenticatedData(context, envelope.keyId));
      decipher.setAuthTag(authenticationTag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
      return this.validator.encode(parsed as AgentJsonValue, context).payload;
    } catch {
      throw rejected('Agent recovery payload authentication failed.');
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      authenticationTag.fill(0);
      plaintext?.fill(0);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw rejected('The Agent persistence codec has been destroyed.');
    }
  }
}

function parseEnvelope(value: AgentJsonValue): EncryptedPayloadEnvelope {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw rejected('The encrypted Agent payload envelope is malformed.');
  }
  const record = value as Record<string, AgentJsonValue>;
  const expectedKeys = [
    'algorithm',
    'authenticationTag',
    'ciphertext',
    'keyId',
    'nonce',
    'schemaVersion'
  ];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw rejected('The encrypted Agent payload envelope has unexpected fields.');
  }
  if (
    record.schemaVersion !== 1
    || record.algorithm !== ALGORITHM
    || typeof record.keyId !== 'string'
    || typeof record.nonce !== 'string'
    || typeof record.ciphertext !== 'string'
    || typeof record.authenticationTag !== 'string'
  ) {
    throw rejected('The encrypted Agent payload envelope is malformed.');
  }
  assertKeyId(record.keyId);
  return {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    keyId: record.keyId,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    authenticationTag: record.authenticationTag
  };
}

function createAdditionalAuthenticatedData(
  context: AgentPersistencePayloadContext,
  keyId: string
): Buffer {
  const legacyContext = {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    keyId,
    codecId: CODEC_ID,
    kind: context.kind,
    runId: context.runId,
    commandId: context.commandId,
    runVersion: context.runVersion,
    checkpointVersion: context.checkpointVersion ?? null,
    effectId: context.effectId ?? null,
    inputDigest: context.inputDigest ?? null,
    planId: context.planId ?? null,
    planVersion: context.planVersion ?? null,
    contentHash: context.contentHash ?? null,
    delegationId: context.delegationId ?? null,
    objectiveDigest: context.objectiveDigest ?? null,
    directiveDigest: context.directiveDigest ?? null
  };
  // Existing protected kinds retain their exact historical AAD bytes. Only
  // The protected Turn input payload kind appends its Turn identity.
  if (
    context.kind === 'turn_input'
    && (
      typeof context.turnId !== 'string'
      || context.turnId.length === 0
      || context.turnId.length > 256
      || context.turnId.trim() !== context.turnId
      || typeof context.inputDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(context.inputDigest)
    )
  ) {
    throw rejected(
      'Protected Turn input AAD requires canonical Turn and input-digest identities.'
    );
  }
  const authenticated = context.kind === 'turn_input'
    ? { ...legacyContext, turnId: context.turnId }
    : legacyContext;
  return Buffer.from(JSON.stringify(authenticated), 'utf8');
}

function decodeBase64(
  value: string,
  exactBytes: number | undefined,
  field: string
): Buffer {
  if (
    value.length === 0
    || value.length > MAX_ENCODED_COMPONENT_BYTES
    || !BASE64_PATTERN.test(value)
  ) {
    throw rejected(`The Agent persistence ${field} is malformed.`);
  }
  const decoded = Buffer.from(value, 'base64');
  const canonical = Buffer.from(decoded).toString('base64');
  const canonicalBuffer = Buffer.from(canonical, 'ascii');
  const inputBuffer = Buffer.from(value, 'ascii');
  const matches = canonicalBuffer.byteLength === inputBuffer.byteLength
    && timingSafeEqual(canonicalBuffer, inputBuffer);
  canonicalBuffer.fill(0);
  inputBuffer.fill(0);
  if (!matches || (exactBytes !== undefined && decoded.byteLength !== exactBytes)) {
    decoded.fill(0);
    throw rejected(`The Agent persistence ${field} is malformed.`);
  }
  return decoded;
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw rejected('The Agent persistence key id is malformed.');
  }
}

function rejected(message: string): AgentPersistencePayloadRejectedError {
  return new AgentPersistencePayloadRejectedError(message);
}
