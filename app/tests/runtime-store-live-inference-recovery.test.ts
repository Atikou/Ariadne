import { describe, expect, it, vi } from 'vitest';
import type { PublicInferenceStreamProjectionV3, RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from './support/runtime-api';
import { runtimeEnvelope } from './runtime-event-fixture';
import { projectionCommit, projectionSnapshot, readBatch, session, upsertChange } from './projection-v3-fixture';

const identity = { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', attemptId: 'attempt-a' };
const streamId = 'run-a:turn-a:attempt-a';
const at = '2026-09-05T00:00:00.000Z';
function head(sequence: number): PublicInferenceStreamProjectionV3 {
  return { ...identity, inferenceStreamId: streamId, version: sequence, status: 'streaming',
    retainedFromSequence: 1, finalSequence: sequence, updatedAt: at,
    chunks: Array.from({ length: sequence }, (_, i) => ({ sequence: i + 1, channel: 'token', text: String(i + 1), observedAt: at })) };
}

describe('RuntimeStore live recovery through the production Projection client', () => {
  it('requests a durable prefix after a gap, renders the suffix, and does not resurrect a terminated attempt', async () => {
    let receive!: (event: RuntimeEventEnvelope) => void;
    let available: PublicInferenceStreamProjectionV3 | undefined;
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({ availability: 'ready', capabilities: [], observedAt: at }),
      onEvent: listener => { receive = listener; return () => {}; },
      request: async command => {
        if (command.kind === 'projection.snapshot.get') return { kind: 'projection.snapshot',
          snapshot: projectionSnapshot({ sessions: [session(identity.sessionId)], inferenceStreams: [head(1)] }) };
        if (command.kind !== 'projection.commits.read') throw new Error('unexpected command');
        const commits = available === undefined ? [] : [projectionCommit('head-2', [upsertChange('inference_streams', available, streamId)])];
        available = undefined;
        return { kind: 'projection.commits', batch: readBatch(command.request.afterCursor, command.request.afterDigest, commits) };
      }
    }));
    try {
      await store.initialize();
      expect(store.getSnapshot().lastError).toBeNull();
      await store.sessions.select(identity.sessionId);
      available = head(2);
      receive(runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.chunk.observed',
        sequence: 3, channel: 'token', text: '3', observedAt: at }, 3));
      await vi.waitFor(() => expect(store.getSnapshot().messages[0]?.content).toBe('123'));
      expect(store.getSnapshot().lastError).toBeNull();
      receive(runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.stream.terminated',
        finalSequence: 3, state: 'committed', occurredAt: at }, 4));
      expect(store.getSnapshot().messages.some(message => message.status === 'streaming')).toBe(false);
    } finally { store.dispose(); }
  });
});
