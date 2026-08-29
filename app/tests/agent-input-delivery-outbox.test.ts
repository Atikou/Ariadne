import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentInputDeliveryOutbox
} from '../src/main/persistence/agent-input-delivery-outbox';
import type { SecretCipher } from '../src/main/persistence/secret-cipher';

const temporaryDirectories: string[] = [];
const NOW = new Date('2026-08-29T12:00:00.000Z');
const cipher: SecretCipher = {
  encrypt(value) {
    return `sealed:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt(value) {
    if (!value.startsWith('sealed:')) throw new Error('secure_storage_failure');
    return Buffer.from(value.slice('sealed:'.length), 'base64').toString('utf8');
  }
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(tmpdir())) {
      throw new Error('Refusing to clean a non-temporary test directory.');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe('AgentInputDeliveryOutbox', () => {
  it('OS-seals the exact unsettled command and restores it after a desktop restart', async () => {
    const { file, store } = await createStore();
    const command = inboxCommand('input-restart', 'Keep this private across restart.');

    const staged = await store.stage({ commandId: 'command-restart', command });
    const persisted = await readFile(file, 'utf8');
    expect(staged).toEqual({
      commandId: 'command-restart',
      command,
      createdAt: NOW.toISOString()
    });
    expect(persisted).not.toContain('command-restart');
    expect(persisted).not.toContain('Keep this private across restart.');

    const reopened = new AgentInputDeliveryOutbox(file, cipher, () => NOW);
    await reopened.initialize();
    expect(reopened.list()).toEqual([staged]);
  });

  it('is idempotent for one exact command and rejects command drift', async () => {
    const { store } = await createStore();
    const command = inboxCommand('input-idempotent', 'Same payload.');

    const first = await store.stage({ commandId: 'command-idempotent', command });
    await expect(store.stage({ commandId: 'command-idempotent', command }))
      .resolves.toEqual(first);
    await expect(store.stage({
      commandId: 'command-idempotent',
      command: { ...command, content: 'Drifted payload.' }
    })).rejects.toThrow('agent_input_delivery_outbox_command_conflict');
  });

  it('serializes concurrent stages without losing either record and removes only settlement', async () => {
    const { file, store } = await createStore();
    await Promise.all([
      store.stage({
        commandId: 'command-a',
        command: inboxCommand('input-a', 'A')
      }),
      store.stage({
        commandId: 'command-b',
        command: inboxCommand('input-b', 'B')
      })
    ]);
    expect(store.list().map((record) => record.commandId)).toEqual([
      'command-a',
      'command-b'
    ]);

    await store.settle('command-a');
    const reopened = new AgentInputDeliveryOutbox(file, cipher, () => NOW);
    await reopened.initialize();
    expect(reopened.list().map((record) => record.commandId)).toEqual(['command-b']);
  });

  it('rejects non-inbox commands and corrupted encrypted identity', async () => {
    const { file, store } = await createStore();
    await expect(store.stage({
      commandId: 'command-invalid',
      command: { kind: 'runtime.status.get' } as never
    })).rejects.toThrow('agent_input_delivery_outbox_command_unsupported');

    await store.stage({
      commandId: 'command-corrupt',
      command: inboxCommand('input-corrupt', 'Corrupt me.')
    });
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      records: Record<string, { ciphertext: string }>;
    };
    const key = Object.keys(raw.records)[0]!;
    raw.records[key]!.ciphertext = cipher.encrypt(JSON.stringify({
      commandId: 'different-command',
      command: inboxCommand('input-corrupt', 'Corrupt me.'),
      createdAt: NOW.toISOString()
    }));
    await import('node:fs/promises').then(({ writeFile }) => (
      writeFile(file, JSON.stringify(raw), 'utf8')
    ));

    const reopened = new AgentInputDeliveryOutbox(file, cipher, () => NOW);
    await expect(reopened.initialize()).rejects.toThrow(
      'agent_input_delivery_outbox_invalid'
    );
  });
});

async function createStore(): Promise<{
  directory: string;
  file: string;
  store: AgentInputDeliveryOutbox;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ariadne-delivery-outbox-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'agent-input-delivery-outbox.json');
  const store = new AgentInputDeliveryOutbox(file, cipher, () => NOW);
  await store.initialize();
  return { directory, file, store };
}

function inboxCommand(inputId: string, content: string) {
  return {
    kind: 'agent.inbox.enqueue.v3' as const,
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    runId: 'run-delivery',
    sessionId: 'session-a',
    inputId,
    delivery: 'next_turn' as const,
    content
  };
}
