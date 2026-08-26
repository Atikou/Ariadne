import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteRuntimeCommandJournal } from '../src/adapters/persistence/SqliteRuntimeCommandJournal.js';
import {
  RUNTIME_COMMAND_DB_SCHEMA_VERSION,
  resolveRuntimeCommandDatabasePath
} from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import type { AgentControlRuntimeFactory } from '../src/ingress/AgentControlLifecycle.js';
import type { RuntimeApplicationFactory } from '../src/ingress/RuntimeApplication.js';
import type { RuntimeCommandJournal } from '../src/ingress/RuntimeCommandJournal.js';
import { preflightMemoryControlShadows } from '../src/adapters/persistence/memoryControlShadowRetirement.js';
import { ComposedRuntimeIngress } from '../src/composition/ComposedRuntimeIngress.js';
import { NodeIpcRuntimeHost } from '../src/transport/NodeIpcRuntimeHost.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);

afterEach(() => {
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('NodeIpcRuntimeHost initialization fencing', () => {
  it.each(['unmanaged', 'future', 'occupied'] as const)(
    'does not mutate conversation memory when the Runtime command DB is %s',
    async (mode) => {
      const dataRoot = createRoot();
      const memoryPath = createMemorySentinel(dataRoot);
      const before = snapshotMemory(memoryPath);
      let occupiedJournal: SqliteRuntimeCommandJournal | undefined;

      const runtimeCommandPath = resolveRuntimeCommandDatabasePath(dataRoot);
      mkdirSync(path.dirname(runtimeCommandPath), { recursive: true });
      if (mode === 'occupied') {
        occupiedJournal = new SqliteRuntimeCommandJournal();
        occupiedJournal.open(dataRoot);
      } else {
        const database = new DatabaseSync(runtimeCommandPath);
        if (mode === 'future') {
          database.exec(`PRAGMA user_version = ${String(RUNTIME_COMMAND_DB_SCHEMA_VERSION + 1)}`);
        } else {
          database.exec('CREATE TABLE alien_control_state (id TEXT PRIMARY KEY)');
        }
        database.close();
      }

      const createApplication = vi.fn(async () => {
        throw new Error('conversation_context_must_not_be_created');
      });
      const host = hostForInitialization(
        new SqliteRuntimeCommandJournal(),
        undefined,
        createApplication
      );
      try {
        await initialize(host, createBootstrap(dataRoot));
      } finally {
        occupiedJournal?.close();
      }

      expect(createApplication).not.toHaveBeenCalled();
      expect(snapshotMemory(memoryPath)).toEqual(before);
    }
  );

  it('rejects a relative dataRoot before creating any directory or opening a store', async () => {
    const relativeDataRoot = `relative-runtime-data-${randomUUID()}`;
    const relativePath = path.resolve(relativeDataRoot);
    expect(existsSync(relativePath)).toBe(false);
    const journal = new OrderedJournal([]);
    const createApplication = vi.fn(async () => {
      throw new Error('conversation_context_must_not_be_created');
    });
    const host = hostForInitialization(journal, undefined, createApplication);

    await initialize(host, createBootstrap(relativeDataRoot));

    expect(journal.opened).toBe(false);
    expect(createApplication).not.toHaveBeenCalled();
    expect(existsSync(relativePath)).toBe(false);
  });

  it('blocks populated legacy control shadows before opening either dedicated store', async () => {
    const dataRoot = createRoot();
    const memoryPath = path.join(dataRoot, 'data', 'agent_data', 'memory.db');
    mkdirSync(path.dirname(memoryPath), { recursive: true });
    const database = new DatabaseSync(memoryPath);
    database.exec(`
      CREATE TABLE runtime_commands (command_id TEXT PRIMARY KEY);
      INSERT INTO runtime_commands (command_id) VALUES ('legacy-command');
    `);
    database.close();
    const journal = new OrderedJournal([]);
    const agentFactory: AgentControlRuntimeFactory = {
      create: vi.fn(async () => { throw new Error('agent_must_not_open'); })
    };
    const createApplication = vi.fn(async () => {
      throw new Error('conversation_context_must_not_be_created');
    });
    const host = hostForInitialization(journal, agentFactory, createApplication);

    await initialize(host, createBootstrap(dataRoot));

    expect(journal.opened).toBe(false);
    expect(agentFactory.create).not.toHaveBeenCalled();
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('releases partially initialized resources in strict reverse order', async () => {
    const order: string[] = [];
    const journal = new OrderedJournal(order);
    const agentFactory: AgentControlRuntimeFactory = {
      create: async () => {
        order.push('agent-open');
        return {
          schemaVersion: 13,
          storageSchemas: { agentControl: 13, publicProjection: 1 },
          start: async () => undefined,
          assertHealthy: () => undefined,
          executeOwnedCommand: async () => null,
          reconcileUncertainCommand: async () => null,
          prepareShutdown: async () => undefined,
          shutdown: async () => { order.push('agent-close'); }
        };
      }
    };
    const createApplication = vi.fn(async () => {
      order.push('context-create');
      return {
        storageSchemas: {},
        publicEventSink: { append: async () => undefined },
        modelCatalog: { snapshot: () => [] },
        start: async () => { throw new Error('fail_after_application_create'); },
        execute: async () => { throw new Error('not_used'); },
        status: () => ({
          availability: 'ready' as const,
          capabilities: [],
          observedAt: new Date().toISOString()
        }),
        prepareShutdown: async () => undefined,
        stop: async () => undefined,
        shutdown: async () => undefined,
        disposeInitialization: async () => { order.push('context-close'); }
      };
    });
    const host = hostForInitialization(
      journal,
      agentFactory,
      createApplication,
      () => { order.push('legacy-preflight'); }
    );

    await initialize(host, createBootstrap(createRoot()));

    expect(order).toEqual([
      'legacy-preflight',
      'journal-open',
      'context-create',
      'agent-open',
      'agent-close',
      'context-close',
      'journal-close'
    ]);
  });
});

class OrderedJournal implements RuntimeCommandJournal {
  readonly schemaVersion = 17;
  opened = false;

  constructor(private readonly order: string[]) {}

  open(): void {
    this.opened = true;
    this.order.push('journal-open');
  }

  begin(): never { throw new Error('not_used'); }
  getStatus(): null { return null; }
  complete(): void { throw new Error('not_used'); }
  markUncertain(): void { throw new Error('not_used'); }

  close(): void {
    this.order.push('journal-close');
  }
}

function hostForInitialization(
  journal: RuntimeCommandJournal,
  agentFactory: AgentControlRuntimeFactory | undefined,
  createApplication: RuntimeApplicationFactory['create'],
  legacyPreflight?: (dataRoot: string) => unknown
): NodeIpcRuntimeHost {
  const ingress = new ComposedRuntimeIngress({
    commandJournal: journal,
    ...(agentFactory ? { agentControlFactory: agentFactory } : {}),
    runtimeApplicationFactory: { create: createApplication },
    preflightMemoryControlShadows: legacyPreflight ?? preflightMemoryControlShadows,
    readBuildManifest: () => ({
      schemaVersion: 1,
      runtimeVersion: '0.1.0',
      fingerprint
    })
  });
  const host = new NodeIpcRuntimeHost(ingress);
  (host as unknown as { failClosed(): Promise<void> }).failClosed = vi.fn(async () => undefined);
  return host;
}

function initialize(host: NodeIpcRuntimeHost, bootstrap: RuntimeBootstrap): Promise<void> {
  return (host as unknown as {
    initialize(value: RuntimeBootstrap): Promise<void>;
  }).initialize(bootstrap);
}

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-host-preflight-'));
  roots.push(root);
  return root;
}

function createBootstrap(dataRoot: string): RuntimeBootstrap {
  const workspaceRoot = createRoot();
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: fingerprint,
    installRoot: path.resolve('.'),
    dataRoot,
    modelRoots: [],
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'default',
    workspaces: [{
      workspaceId: 'primary',
      label: 'Project',
      rootPath: workspaceRoot,
      access: 'write'
    }],
    production: false
  };
}

function createMemorySentinel(dataRoot: string): string {
  const databasePath = path.join(dataRoot, 'data', 'agent_data', 'memory.db');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sentinel (id, value) VALUES (1, 'unchanged');
    PRAGMA user_version = 37;
  `);
  database.close();
  return databasePath;
}

function snapshotMemory(databasePath: string): {
  readonly bytes: string;
  readonly userVersion: number;
  readonly schema: readonly string[];
} {
  const bytes = readFileSync(databasePath).toString('base64');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    const schema = database.prepare(
      `SELECT type || ':' || name || ':' || COALESCE(sql, '') AS identity
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    ).all() as unknown as Array<{ identity: string }>;
    return {
      bytes,
      userVersion: Number(version.user_version),
      schema: schema.map((row) => row.identity)
    };
  } finally {
    database.close();
  }
}
