import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AgentPersistenceKeyRing,
  HostCapabilityOperation
} from '@ariadne/protocol/host';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST
} from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAgentControlDatabasePath
} from '../src/adapters/persistence/agentControlDbSchema.js';
import {
  SqliteAgentRunUnitOfWork
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  DefaultAgentControlRuntimeFactory
} from '../src/composition/DefaultAgentControlRuntimeFactory.js';
import {
  projectionWakeAggregateId
} from '../src/composition/PublicProjectionWakeCommitSink.js';
import type { HostCapabilityClient } from '../src/ingress/HostCapabilityClient.js';
import type { ShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const runtimeInstanceId = '00000000-0000-4000-8000-000000000030';
const activeKeyId = 'agent-key-00000000-0000-4000-8000-000000000031';
const emptyModelCatalog = Object.freeze({ snapshot: () => Object.freeze([]) });
const discardPublicEventSink = Object.freeze({ append: async () => undefined });

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DefaultAgentControlRuntimeFactory', () => {
  it('loads instance-bound keys, anchors them, and never persists key material', async () => {
    const root = createRoot();
    const keyMaterialBase64 = Buffer.alloc(32, 71).toString('base64');
    const operations: HostCapabilityOperation[] = [];
    const factory = new DefaultAgentControlRuntimeFactory();
    const runtime = await factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(
        keyRing(2, activeKeyId, keyMaterialBase64),
        operations
      )
    });

    expect(operations).toEqual([{
      kind: 'agent.persistence.keyring.read'
    }]);
    const databasePath = resolveAgentControlDatabasePath(root);
    expect(readFileSync(databasePath).includes(
      Buffer.from(keyMaterialBase64, 'utf8')
    )).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        'SELECT key, value FROM agent_control_metadata ORDER BY key'
      ).all()).toEqual([
        { key: 'active_key_id', value: activeKeyId },
        { key: 'keyring_generation', value: '2' }
      ]);
    } finally {
      database.close();
    }

    await runtime.shutdown(shutdownContext());
  });

  it('reopens an exact anchor and rejects rollback or uncommitted rotation', async () => {
    const root = createRoot();
    const material = Buffer.alloc(32, 83).toString('base64');
    const factory = new DefaultAgentControlRuntimeFactory();
    const first = await factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(4, activeKeyId, material))
    });
    await first.shutdown(shutdownContext());

    const reopened = await factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(4, activeKeyId, material))
    });
    await reopened.shutdown(shutdownContext());

    await expect(factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(3, activeKeyId, material))
    })).rejects.toThrow('agent_keyring_anchor_rollback');
    await expect(factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(
        5,
        'agent-key-00000000-0000-4000-8000-000000000032',
        Buffer.alloc(32, 89).toString('base64')
      ))
    })).rejects.toThrow('agent_keyring_anchor_rotation_not_committed');

    const finalReopen = await factory.create({
      dataRoot: root,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(4, activeKeyId, material))
    });
    await finalReopen.shutdown(shutdownContext());
  });

  it('uses the development guard without requesting production keys', async () => {
    const request = vi.fn(async () => {
      throw new Error('keyring_should_not_be_requested');
    });
    const runtime = await new DefaultAgentControlRuntimeFactory().create({
      dataRoot: createRoot(),
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: { request }
    });

    expect(request).not.toHaveBeenCalled();
    await runtime.shutdown(shutdownContext());
  });

  it('rejects a non-canonical dataRoot before requesting keys or creating directories', async () => {
    const relativeRoot = `relative-agent-control-${runtimeInstanceId}`;
    const resolvedRoot = path.resolve(relativeRoot);
    const request = vi.fn(async () => {
      throw new Error('keyring_should_not_be_requested');
    });

    await expect(new DefaultAgentControlRuntimeFactory().create({
      dataRoot: relativeRoot,
      production: true,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: { request }
    })).rejects.toThrow('runtime_bootstrap_data_root_not_canonical_absolute');

    expect(request).not.toHaveBeenCalled();
    expect(existsSync(resolvedRoot)).toBe(false);
  });

  it('releases the Agent owner fence when lifecycle construction fails', async () => {
    const root = createRoot();
    const factory = new DefaultAgentControlRuntimeFactory({
      publisher: { claimLimit: 0 }
    });

    await expect(factory.create({
      dataRoot: root,
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(
        1,
        activeKeyId,
        Buffer.alloc(32, 91).toString('base64')
      ))
    })).rejects.toThrow('agent_run_projection_options_invalid');

    const reopened = new SqliteAgentRunUnitOfWork(root);
    await reopened.close(shutdownContext());
  });

  it('owns v3 Snapshot and digest-bound replay queries without invoking legacy Runtime', async () => {
    const runtime = await new DefaultAgentControlRuntimeFactory().create({
      dataRoot: createRoot(),
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(
        1,
        activeKeyId,
        Buffer.alloc(32, 97).toString('base64')
      ))
    });
    await runtime.start();
    const signal = new AbortController().signal;
    const snapshotResult = await runtime.executeOwnedCommand({
      commandId: 'projection-snapshot-query',
      correlationId: 'projection-snapshot-query',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: {
        kind: 'projection.snapshot.get',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
      }
    });
    expect(snapshotResult).toMatchObject({
      settlement: 'completed',
      outcome: {
        ok: true,
        result: {
          kind: 'projection.snapshot',
          snapshot: {
            cursor: 0,
            cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
            runs: []
          }
        }
      }
    });
    expect(runtime.storageSchemas).toEqual({
      agentControl: runtime.schemaVersion,
      conversation: 3,
      publicProjection: 2
    });
    await expect(runtime.executeOwnedCommand({
      commandId: 'legacy-query',
      correlationId: 'legacy-query',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: { kind: 'runtime.status.get' }
    })).resolves.toBeNull();
    await runtime.shutdown(shutdownContext());
  });

  it('binds live-work completion before start and drains it before Agent stores close', async () => {
    const order: string[] = [];
    const bindCompletionSink = vi.fn(() => ({
      assertHealthy: vi.fn(),
      drain: vi.fn(async () => { order.push('drain'); }),
      unbind: vi.fn(() => { order.push('unbind'); })
    }));
    const runtime = await new DefaultAgentControlRuntimeFactory().create({
      dataRoot: createRoot(),
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(
        1,
        activeKeyId,
        Buffer.alloc(32, 99).toString('base64')
      )),
      runtimeServices: {
        liveWorkLifecycle: {
          closeOwner: vi.fn(),
          close: vi.fn(async () => { order.push('close'); }),
          bindCompletionSink
        }
      }
    });

    expect(bindCompletionSink).toHaveBeenCalledTimes(1);
    await runtime.start();
    await runtime.shutdown(shutdownContext());
    expect(order).toEqual(['close', 'drain', 'unbind']);
  });

  it('publishes the bound Runtime model catalog into the v3 Snapshot before ready', async () => {
    const appendPublicEvent = vi.fn(async () => undefined);
    const runtime = await new DefaultAgentControlRuntimeFactory({
      publishIntervalMs: 60_000
    }).create({
      dataRoot: createRoot(),
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: {
        snapshot: () => [{
          id: 'cloud-deepseek',
          label: 'deepseek-chat',
          location: 'remote',
          availability: 'ready',
          supportsAgent: true,
          supportsVision: false
        }]
      },
      publicEventSink: { append: appendPublicEvent },
      hostCapabilities: broker(keyRing(
        1,
        activeKeyId,
        Buffer.alloc(32, 101).toString('base64')
      ))
    });
    try {
      await runtime.start();
      const result = await runtime.executeOwnedCommand({
        commandId: 'projection-model-snapshot-query',
        correlationId: 'projection-model-snapshot-query',
        deadlineAt: '2031-01-01T00:00:00.000Z',
        signal: new AbortController().signal,
        command: {
          kind: 'projection.snapshot.get',
          contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
        }
      });
      expect(result).toMatchObject({
        settlement: 'completed',
        outcome: {
          ok: true,
          result: {
            kind: 'projection.snapshot',
            snapshot: {
              models: [{
                modelId: 'cloud-deepseek',
                version: 1,
                label: 'deepseek-chat',
                location: 'remote',
                availability: 'ready',
                supportsAgent: true,
                supportsVision: false
              }]
            }
          }
        }
      });
      expect(appendPublicEvent).toHaveBeenCalledTimes(1);
      expect(appendPublicEvent).toHaveBeenCalledWith(expect.objectContaining({
        aggregateType: 'projection',
        aggregateId: projectionWakeAggregateId('model-catalog', 'models'),
        aggregateVersion: 1,
        event: {
          kind: 'projection.changed',
          feature: 'models'
        }
      }));
    } finally {
      await runtime.shutdown(shutdownContext());
    }
  });

  it('owns Conversation session creation but rejects messages before write without Handoff', async () => {
    let clockOffsetSeconds = 0;
    const runtime = await new DefaultAgentControlRuntimeFactory({
      publishIntervalMs: 60_000,
      conversationCommandNow: () => new Date(
        Date.UTC(2030, 0, 1, 0, 0, clockOffsetSeconds++)
      )
    }).create({
      dataRoot: createRoot(),
      production: false,
      runtimeInstanceId,
      agentAdmissionAuthoritySource: disabledAdmissionAuthoritySource(),
      modelProviders: [],
      modelCatalog: emptyModelCatalog,
      publicEventSink: discardPublicEventSink,
      hostCapabilities: broker(keyRing(
        1,
        activeKeyId,
        Buffer.alloc(32, 101).toString('base64')
      ))
    });
    await runtime.start();
    const signal = new AbortController().signal;
    const createEnvelope = {
      commandId: 'conversation-create-command-v3',
      correlationId: 'conversation-create-command-v3',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: {
        kind: 'conversation.session.create.v3' as const,
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-control-v3',
        workspaceId: 'workspace-control-v3'
      }
    };
    const createResult = await runtime.executeOwnedCommand(createEnvelope);
    expect(createResult).toMatchObject({
      settlement: 'completed',
      outcome: {
        ok: true,
        result: {
          kind: 'conversation.session.created.v3',
          version: 1
        }
      }
    });
    await expect(runtime.executeOwnedCommand(createEnvelope)).resolves.toEqual(createResult);
    await expect(runtime.executeOwnedCommand({
      commandId: 'conversation-accept-command-v3',
      correlationId: 'conversation-accept-command-v3',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: {
        kind: 'conversation.message.accept.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-control-v3',
        workspaceId: 'workspace-control-v3',
        expectedSessionVersion: 1,
        messageId: 'message-control-v3',
        content: 'public conversation body'
      }
    })).resolves.toMatchObject({
      settlement: 'completed',
      outcome: {
        ok: false,
        error: {
          code: 'agent_execution_unavailable',
          retryable: false,
          correlationId: 'conversation-accept-command-v3'
        }
      }
    });
    await expect(runtime.executeOwnedCommand({
      commandId: 'conversation-stale-command-v3',
      correlationId: 'conversation-stale-command-v3',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: {
        kind: 'conversation.message.accept.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        sessionId: 'session-control-v3',
        workspaceId: 'workspace-control-v3',
        expectedSessionVersion: 1,
        messageId: 'message-stale-control-v3',
        content: 'must not be committed from a stale session version'
      }
    })).resolves.toEqual({
      settlement: 'completed',
      outcome: {
        ok: false,
        error: {
          code: 'agent_execution_unavailable',
          message: 'Agent execution is unavailable because its durable Handoff producer is not configured.',
          retryable: false,
          correlationId: 'conversation-stale-command-v3'
        }
      }
    });
    const snapshotEnvelope = {
      commandId: 'conversation-snapshot-query-v3',
      correlationId: 'conversation-snapshot-query-v3',
      deadlineAt: '2031-01-01T00:00:00.000Z',
      signal,
      command: {
        kind: 'projection.snapshot.get' as const,
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
      }
    };
    await expect.poll(async () => runtime.executeOwnedCommand(snapshotEnvelope), {
      timeout: 1_000,
      interval: 5
    }).toMatchObject({
      outcome: {
        ok: true,
        result: {
          kind: 'projection.snapshot',
          snapshot: {
            cursor: 1,
            sessions: [{ sessionId: 'session-control-v3', version: 1 }],
            messages: []
          }
        }
      }
    });
    await runtime.shutdown(shutdownContext());
  });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-agent-control-factory-'));
  roots.push(root);
  return root;
}

function broker(
  ring: AgentPersistenceKeyRing,
  operations: HostCapabilityOperation[] = []
): HostCapabilityClient {
  return {
    async request(operation) {
      operations.push(operation);
      return ring;
    }
  };
}

function keyRing(
  generation: number,
  keyId: string,
  keyMaterialBase64: string
): AgentPersistenceKeyRing {
  return {
    schemaVersion: 1,
    runtimeInstanceId,
    generation,
    activeKeyId: keyId,
    keys: [{ keyId, keyMaterialBase64 }]
  };
}

function shutdownContext(): ShutdownContext {
  return {
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
    remainingMs: () => 5_000,
    throwIfExpired: () => undefined
  };
}

function disabledAdmissionAuthoritySource() {
  return {
    sourceVersion: 1 as const,
    status: 'disabled' as const,
    reason: 'not_configured' as const
  };
}
