import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm
} from 'node:fs/promises';
import path from 'node:path';

import type { SecretCipher } from './secret-cipher';

const KEY_BYTES = 32;
const MAX_KEYS = 32;
const MAX_SEALED_MANIFEST_BYTES = 256 * 1024;
const KEY_ID_PATTERN =
  /^agent-key-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface AgentPersistenceKeyManifestEntry {
  readonly keyId: string;
  readonly status: 'active' | 'decrypt-only';
  readonly createdAt: string;
  readonly keyMaterialBase64: string;
}

interface AgentPersistenceKeyManifest {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly activeKeyId: string;
  readonly keys: readonly AgentPersistenceKeyManifestEntry[];
}

interface PersistedSealedKeyManifest {
  readonly schemaVersion: 1;
  readonly sealedManifest: string;
}

export interface RuntimeAgentPersistenceDataKey {
  readonly keyId: string;
  readonly keyMaterialBase64: string;
}

export interface RuntimeAgentPersistenceKeyRing {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly activeKeyId: string;
  readonly keys: readonly RuntimeAgentPersistenceDataKey[];
}

const pathOperationQueues = new Map<string, Promise<void>>();

/**
 * Electron-Main-owned key ring for authoritative Agent recovery payloads.
 *
 * The complete canonical manifest is sealed as one authenticated OS-storage
 * value, so active/status/generation metadata cannot be edited independently
 * of the key material. Runtime receives only an unsealed, in-memory copy.
 */
export class AgentPersistenceKeyRingStore {
  private readonly queueKey: string;

  public constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly clock: () => Date = () => new Date(),
    private readonly createKey: () => Buffer = () => randomBytes(KEY_BYTES),
    private readonly createKeyId: () => string = () => `agent-key-${randomUUID()}`
  ) {
    const resolvedPath = path.resolve(filePath);
    this.queueKey = process.platform === 'win32'
      ? resolvedPath.toLocaleLowerCase('en-US')
      : resolvedPath;
  }

  public initialize(): Promise<void> {
    return this.runExclusive(async () => {
      try {
        await this.readPersisted();
        return;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }

      const key = this.createAndValidateKey();
      try {
        const keyId = this.createAndValidateKeyId();
        const manifest: AgentPersistenceKeyManifest = {
          schemaVersion: 1,
          generation: 1,
          activeKeyId: keyId,
          keys: [{
            keyId,
            status: 'active',
            createdAt: this.clock().toISOString(),
            keyMaterialBase64: key.toString('base64')
          }]
        };
        await this.writePersisted(manifest, null);

        // Initialization is successful only if the just-persisted value can
        // actually be unsealed and passes canonical manifest validation.
        await this.readPersisted();
      } finally {
        key.fill(0);
      }
    });
  }

  public loadForRuntime(): Promise<RuntimeAgentPersistenceKeyRing> {
    return this.runExclusive(async () => {
      const manifest = await this.readPersisted();
      return {
        schemaVersion: 1,
        generation: manifest.generation,
        activeKeyId: manifest.activeKeyId,
        keys: manifest.keys.map((entry) => ({
          keyId: entry.keyId,
          keyMaterialBase64: entry.keyMaterialBase64
        }))
      };
    });
  }

  public rotate(): Promise<string> {
    return this.runExclusive(async () => {
      const current = await this.readPersisted();
      const nextKey = this.createAndValidateKey();
      try {
        const keyId = this.createAndValidateKeyId();
        const next: AgentPersistenceKeyManifest = {
          schemaVersion: 1,
          generation: current.generation + 1,
          activeKeyId: keyId,
          keys: [
            ...current.keys.map((entry) => ({
              ...entry,
              status: 'decrypt-only' as const
            })),
            {
              keyId,
              status: 'active',
              createdAt: this.clock().toISOString(),
              keyMaterialBase64: nextKey.toString('base64')
            }
          ]
        };
        await this.writePersisted(next, current.generation);
        return keyId;
      } finally {
        nextKey.fill(0);
      }
    });
  }

  private async readPersisted(): Promise<AgentPersistenceKeyManifest> {
    const raw = await readFile(this.filePath, 'utf8');
    const persisted = parsePersistedSealedManifest(parseJson(raw));
    const unsealed = this.cipher.decrypt(persisted.sealedManifest);
    const manifest = parseManifest(parseJson(unsealed));
    if (serializeManifest(manifest) !== unsealed) {
      throw new Error('agent_persistence_keyring_noncanonical');
    }
    return manifest;
  }

  private async writePersisted(
    manifest: AgentPersistenceKeyManifest,
    expectedGeneration: number | null
  ): Promise<void> {
    const validated = parseManifest(manifest);
    if (
      (expectedGeneration === null && validated.generation !== 1)
      || (expectedGeneration !== null
        && validated.generation !== expectedGeneration + 1)
    ) {
      throw new Error('agent_persistence_keyring_generation_conflict');
    }

    const canonical = serializeManifest(validated);
    const sealedManifest = this.cipher.encrypt(canonical);
    if (
      sealedManifest.length === 0
      || Buffer.byteLength(sealedManifest, 'utf8') > MAX_SEALED_MANIFEST_BYTES
      || sealedManifest === canonical
      || validated.keys.some((entry) =>
        sealedManifest.includes(entry.keyMaterialBase64))
    ) {
      throw new Error('agent_persistence_keyring_seal_failed');
    }
    if (this.cipher.decrypt(sealedManifest) !== canonical) {
      throw new Error('agent_persistence_keyring_seal_verification_failed');
    }

    const persisted: PersistedSealedKeyManifest = {
      schemaVersion: 1,
      sealedManifest
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      temporaryHandle = await open(temporaryPath, 'wx', 0o600);
      await temporaryHandle.writeFile(
        `${JSON.stringify(persisted, null, 2)}\n`,
        { encoding: 'utf8' }
      );
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      await this.assertExpectedGeneration(expectedGeneration);
      await rename(temporaryPath, this.filePath);
      await syncParentDirectory(path.dirname(this.filePath));
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async assertExpectedGeneration(
    expectedGeneration: number | null
  ): Promise<void> {
    try {
      const current = await this.readPersisted();
      if (
        expectedGeneration === null
        || current.generation !== expectedGeneration
      ) {
        throw new Error('agent_persistence_keyring_generation_conflict');
      }
    } catch (error) {
      if (isMissingFile(error)) {
        if (expectedGeneration === null) return;
        throw new Error('agent_persistence_keyring_generation_conflict');
      }
      throw error;
    }
  }

  private createAndValidateKey(): Buffer {
    const key = this.createKey();
    if (key.byteLength !== KEY_BYTES) {
      key.fill(0);
      throw new Error('agent_persistence_generated_key_malformed');
    }
    try {
      return Buffer.from(key);
    } finally {
      key.fill(0);
    }
  }

  private createAndValidateKeyId(): string {
    const keyId = this.createKeyId();
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error('agent_persistence_generated_key_id_malformed');
    }
    return keyId;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pathOperationQueues.get(this.queueKey) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    pathOperationQueues.set(this.queueKey, tail);
    return result.finally(() => {
      if (pathOperationQueues.get(this.queueKey) === tail) {
        pathOperationQueues.delete(this.queueKey);
      }
    });
  }
}

function parsePersistedSealedManifest(value: unknown): PersistedSealedKeyManifest {
  if (!isRecord(value)) throw new Error('agent_persistence_keyring_malformed');
  assertExactKeys(value, ['schemaVersion', 'sealedManifest']);
  if (
    value.schemaVersion !== 1
    || typeof value.sealedManifest !== 'string'
    || value.sealedManifest.length === 0
    || Buffer.byteLength(value.sealedManifest, 'utf8') > MAX_SEALED_MANIFEST_BYTES
  ) {
    throw new Error('agent_persistence_keyring_malformed');
  }
  return {
    schemaVersion: 1,
    sealedManifest: value.sealedManifest
  };
}

function parseManifest(value: unknown): AgentPersistenceKeyManifest {
  if (!isRecord(value)) throw new Error('agent_persistence_keyring_malformed');
  assertExactKeys(value, [
    'activeKeyId',
    'generation',
    'keys',
    'schemaVersion'
  ]);
  if (
    value.schemaVersion !== 1
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || typeof value.activeKeyId !== 'string'
    || !KEY_ID_PATTERN.test(value.activeKeyId)
    || !Array.isArray(value.keys)
    || value.keys.length === 0
    || value.keys.length > MAX_KEYS
  ) {
    throw new Error('agent_persistence_keyring_malformed');
  }

  const seenIds = new Set<string>();
  const decodedMaterials: Array<{ readonly keyId: string; readonly key: Buffer }> = [];
  let activeCount = 0;
  try {
    const keys = value.keys.map((candidate): AgentPersistenceKeyManifestEntry => {
      if (!isRecord(candidate)) {
        throw new Error('agent_persistence_keyring_malformed');
      }
      assertExactKeys(candidate, [
        'createdAt',
        'keyId',
        'keyMaterialBase64',
        'status'
      ]);
      if (
        typeof candidate.keyId !== 'string'
        || !KEY_ID_PATTERN.test(candidate.keyId)
        || seenIds.has(candidate.keyId)
        || (candidate.status !== 'active' && candidate.status !== 'decrypt-only')
        || typeof candidate.createdAt !== 'string'
        || !isIsoTimestamp(candidate.createdAt)
        || typeof candidate.keyMaterialBase64 !== 'string'
      ) {
        throw new Error('agent_persistence_keyring_malformed');
      }
      const key = decodeCanonicalKey(candidate.keyMaterialBase64);
      for (const existing of decodedMaterials) {
        if (timingSafeEqual(existing.key, key)) {
          key.fill(0);
          throw new Error('agent_persistence_key_material_reused');
        }
      }
      decodedMaterials.push({ keyId: candidate.keyId, key });
      seenIds.add(candidate.keyId);
      if (candidate.status === 'active') activeCount += 1;
      return {
        keyId: candidate.keyId,
        status: candidate.status,
        createdAt: candidate.createdAt,
        keyMaterialBase64: candidate.keyMaterialBase64
      };
    });
    if (
      activeCount !== 1
      || !keys.some((key) =>
        key.keyId === value.activeKeyId && key.status === 'active')
    ) {
      throw new Error('agent_persistence_keyring_malformed');
    }
    return {
      schemaVersion: 1,
      generation: value.generation as number,
      activeKeyId: value.activeKeyId,
      keys
    };
  } finally {
    for (const material of decodedMaterials) material.key.fill(0);
  }
}

function serializeManifest(manifest: AgentPersistenceKeyManifest): string {
  return JSON.stringify({
    schemaVersion: 1,
    generation: manifest.generation,
    activeKeyId: manifest.activeKeyId,
    keys: manifest.keys.map((entry) => ({
      keyId: entry.keyId,
      status: entry.status,
      createdAt: entry.createdAt,
      keyMaterialBase64: entry.keyMaterialBase64
    }))
  });
}

function decodeCanonicalKey(value: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('agent_persistence_unsealed_key_malformed');
  }
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== KEY_BYTES || key.toString('base64') !== value) {
    key.fill(0);
    throw new Error('agent_persistence_unsealed_key_malformed');
  }
  return key;
}

async function syncParentDirectory(directory: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryHandle = await open(directory, 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('agent_persistence_keyring_malformed');
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('agent_persistence_keyring_malformed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isRecord(error) && typeof error.code === 'string' && [
    'EBADF',
    'EINVAL',
    'EISDIR',
    'ENOTSUP',
    'EPERM'
  ].includes(error.code);
}
