import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentPersistenceKeyRingStore
} from '../src/main/persistence/agent-persistence-keyring';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';

const temporaryDirectories: string[] = [];
const sealedPlaintexts: string[] = [];
let decryptCalls = 0;
const cipher: SecretCipher = {
  encrypt(value) {
    sealedPlaintexts.push(value);
    return seal(value);
  },
  decrypt(value) {
    decryptCalls += 1;
    if (!value.startsWith('sealed:')) throw new Error('secure_storage_failure');
    const encoded = value.slice('sealed:'.length);
    if (!/^(?:[0-9a-f]{2})+$/u.test(encoded)) {
      throw new Error('secure_storage_failure');
    }
    return Buffer.from(encoded, 'hex').toString('utf8');
  }
};

afterEach(async () => {
  sealedPlaintexts.splice(0);
  decryptCalls = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(tmpdir())) {
      throw new Error('Refusing to clean a non-temporary test directory.');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe('AgentPersistenceKeyRingStore', () => {
  it('OS-seals the complete canonical manifest and verifies it during initialization', async () => {
    const { store, file, directory } = await createStore();

    await store.initialize();
    const callsAfterInitialization = decryptCalls;
    const runtime = await store.loadForRuntime();
    const persisted = await readFile(file, 'utf8');
    const persistedEnvelope = JSON.parse(persisted) as Record<string, unknown>;

    expect(callsAfterInitialization).toBeGreaterThanOrEqual(2);
    expect(Object.keys(persistedEnvelope).sort()).toEqual([
      'schemaVersion',
      'sealedManifest'
    ]);
    expect(runtime.generation).toBe(1);
    expect(runtime.keys).toHaveLength(1);
    expect(runtime.activeKeyId).toBe(runtime.keys[0]?.keyId);
    expect(Buffer.from(runtime.keys[0]!.keyMaterialBase64, 'base64')).toHaveLength(32);
    expect(persisted).not.toContain(runtime.activeKeyId);
    expect(persisted).not.toContain(runtime.keys[0]!.keyMaterialBase64);
    expect(sealedPlaintexts[0]).toBe(JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      activeKeyId: runtime.activeKeyId,
      keys: [{
        keyId: runtime.activeKeyId,
        status: 'active',
        createdAt: new Date(Date.UTC(2026, 6, 31, 10, 0)).toISOString(),
        keyMaterialBase64: runtime.keys[0]!.keyMaterialBase64
      }]
    }));
    expect(await readdir(directory)).toEqual(['agent-persistence-keys.json']);
  });

  it('increments generation while retaining the old key for decryption', async () => {
    const { store } = await createStore();
    await store.initialize();
    const before = await store.loadForRuntime();

    const nextKeyId = await store.rotate();
    const after = await store.loadForRuntime();

    expect(after.generation).toBe(2);
    expect(after.activeKeyId).toBe(nextKeyId);
    expect(after.activeKeyId).not.toBe(before.activeKeyId);
    expect(after.keys.map((key) => key.keyId)).toEqual([
      before.activeKeyId,
      nextKeyId
    ]);
    const rotatedManifest = JSON.parse(sealedPlaintexts.at(-1)!) as {
      keys: Array<{ status: string }>;
    };
    expect(rotatedManifest.keys.map((key) => key.status)).toEqual([
      'decrypt-only',
      'active'
    ]);
  });

  it('shares one path queue and generation CAS across different Store instances', async () => {
    const directory = await createTemporaryDirectory();
    const file = path.join(directory, 'agent-persistence-keys.json');
    const first = createStoreForFile(file, 10);
    const second = createStoreForFile(file, 20);

    await Promise.all([first.initialize(), second.initialize()]);
    const rotated = await Promise.all([first.rotate(), second.rotate()]);
    const runtime = await first.loadForRuntime();

    expect(new Set(rotated).size).toBe(2);
    expect(runtime.generation).toBe(3);
    expect(runtime.keys).toHaveLength(3);
    expect(runtime.activeKeyId).toBe(rotated[1]);
  });

  it('does not expose an online decrypt-only key deletion API', async () => {
    const { store } = await createStore();
    await store.initialize();

    expect('removeDecryptOnlyKey' in store).toBe(false);
  });

  it('rejects duplicate key material assigned to different key ids', async () => {
    const directory = await createTemporaryDirectory();
    const file = path.join(directory, 'agent-persistence-keys.json');
    const repeated = Buffer.alloc(32, 9).toString('base64');
    const activeKeyId = keyId(1);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      generation: 2,
      activeKeyId,
      keys: [
        {
          keyId: keyId(2),
          status: 'decrypt-only',
          createdAt: new Date(0).toISOString(),
          keyMaterialBase64: repeated
        },
        {
          keyId: activeKeyId,
          status: 'active',
          createdAt: new Date(1).toISOString(),
          keyMaterialBase64: repeated
        }
      ]
    });
    await writeSealedManifest(file, manifest);
    const store = new AgentPersistenceKeyRingStore(file, cipher);

    await expect(store.initialize()).rejects.toThrow(
      'agent_persistence_key_material_reused'
    );
  });

  it('fails closed instead of accepting a non-canonical unsealed manifest', async () => {
    const directory = await createTemporaryDirectory();
    const file = path.join(directory, 'agent-persistence-keys.json');
    const activeKeyId = keyId(1);
    const noncanonical = JSON.stringify({
      activeKeyId,
      schemaVersion: 1,
      generation: 1,
      keys: [{
        status: 'active',
        keyId: activeKeyId,
        createdAt: new Date(0).toISOString(),
        keyMaterialBase64: Buffer.alloc(32, 7).toString('base64')
      }]
    });
    await writeSealedManifest(file, noncanonical);
    const store = new AgentPersistenceKeyRingStore(file, cipher);

    await expect(store.initialize()).rejects.toThrow(
      'agent_persistence_keyring_noncanonical'
    );
  });

  it('reaches secure-storage decryption and fails closed for an unsealable file', async () => {
    const directory = await createTemporaryDirectory();
    const file = path.join(directory, 'agent-persistence-keys.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      sealedManifest: 'not-sealed'
    }), 'utf8');
    const store = new AgentPersistenceKeyRingStore(file, cipher);

    await expect(store.initialize()).rejects.toThrow('secure_storage_failure');
    expect(decryptCalls).toBe(1);
  });

  it('fails when secure storage cannot verify a newly sealed manifest', async () => {
    const directory = await createTemporaryDirectory();
    const store = new AgentPersistenceKeyRingStore(
      path.join(directory, 'agent-persistence-keys.json'),
      {
        encrypt() {
          return 'opaque-sealed-value';
        },
        decrypt() {
          throw new Error('secure_storage_unavailable');
        }
      }
    );

    await expect(store.initialize()).rejects.toThrow(
      'secure_storage_unavailable'
    );
  });

  it('rejects an identity cipher before raw manifest data can be persisted', async () => {
    const directory = await createTemporaryDirectory();
    const file = path.join(directory, 'agent-persistence-keys.json');
    const store = new AgentPersistenceKeyRingStore(file, {
      encrypt: (value) => value,
      decrypt: (value) => value
    });

    await expect(store.initialize()).rejects.toThrow(
      'agent_persistence_keyring_seal_failed'
    );
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createStore(): Promise<{
  readonly store: AgentPersistenceKeyRingStore;
  readonly file: string;
  readonly directory: string;
}> {
  const directory = await createTemporaryDirectory();
  const file = path.join(directory, 'agent-persistence-keys.json');
  return {
    store: createStoreForFile(file, 0),
    file,
    directory
  };
}

function createStoreForFile(
  file: string,
  sequenceStart: number
): AgentPersistenceKeyRingStore {
  let sequence = sequenceStart;
  return new AgentPersistenceKeyRingStore(
    file,
    cipher,
    () => new Date(Date.UTC(2026, 6, 31, 10, sequence++)),
    () => Buffer.alloc(32, (sequence % 254) + 1),
    () => keyId(sequence)
  );
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ariadne-agent-keys-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSealedManifest(file: string, manifest: string): Promise<void> {
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    sealedManifest: seal(manifest)
  }), 'utf8');
}

function seal(value: string): string {
  return `sealed:${Buffer.from(value, 'utf8').toString('hex')}`;
}

function keyId(sequence: number): string {
  return `agent-key-00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}
