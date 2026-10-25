import { describe, expect, it } from 'vitest';
import { runtimeCommandSchema, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { LongMemoryFeatureStore } from '../src/renderer/src/core/runtime/features/long-memory-feature-store';

describe('memory command serialization from a projected Session', () => {
  it('submits only explicit owner IDs through the strict desktop protocol for every operation', async () => {
    const session = { workspaceId: 'workspace-a', sessionId: 'session-a', title: 'Projected title', version: 4, status: 'active', createdAt: '2026-10-04T00:00:00Z' };
    const commands: RuntimeCommand[] = [];
    const gateway = { execute: async (input: RuntimeCommand): Promise<RuntimeResult> => {
      const command = runtimeCommandSchema.parse(input); commands.push(command);
      switch (command.kind) {
        case 'memory.query': return { kind: 'memory.query_result', memories: [], nextCursor: null };
        case 'memory.read': return { kind: 'memory.read_result', memory: null };
        case 'memory.put': return { kind: 'memory.updated', memoryId: command.memoryId, version: 1 };
        case 'memory.transition': return { kind: 'memory.updated', memoryId: command.memoryId, version: command.expectedVersion + 1 };
        case 'memory.delete': return { kind: 'memory.deleted', memoryId: command.memoryId, version: command.expectedVersion + 1 };
        case 'memory.recall': return { kind: 'memory.recall_result', hits: [], complete: true, embedding: {
          provider: 'lexical', capability: 'lexical_approximation', dimension: 256, modelId: null, degraded: true, reason: 'lexical_approximation_not_semantic' } };
        default: throw new Error('unexpected_memory_command');
      }
    } };
    const feature = new LongMemoryFeatureStore(gateway);
    await feature.query(session); await feature.read(session, 'memory-a');
    await feature.put(session, 'memory-a', null, { scope: 'workspace', memoryType: 'fact', title: 'Memory', content: 'Content', importance: 0.8,
      confidence: 1, sensitivity: 'workspace', retentionUntil: null });
    await feature.transition(session, { memoryId: 'memory-a', version: 7 }, 'activate');
    await feature.forget(session, { memoryId: 'memory-a', version: 8 }); await feature.recall(session, 'Content');
    expect(commands).toHaveLength(6);
    expect(commands.every(command => !Object.hasOwn(command, 'title') || command.kind === 'memory.put')).toBe(true);
    expect(commands.every(command => !Object.hasOwn(command, 'version') && !Object.hasOwn(command, 'createdAt'))).toBe(true);
    expect(commands[3]).toMatchObject({ workspaceId: session.workspaceId, sessionId: session.sessionId, expectedVersion: 7 });
    expect(commands[4]).toMatchObject({ expectedVersion: 8 });
  });
});
