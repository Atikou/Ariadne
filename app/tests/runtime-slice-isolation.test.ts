import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { RuntimeStore } from '../src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from './support/runtime-api';
import { runtimeEnvelope } from './runtime-event-fixture';
import { message, model, NOW, projectionSnapshot, readBatch, session } from './projection-v3-fixture';

describe('Runtime slice isolation with retained history', () => {
  it.each([1_000, 10_000])('coalesces 100 tokens without notifying unrelated features (%i messages)', async count => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let receive!: (event: RuntimeEventEnvelope) => void;
    const history = Array.from({ length: count }, (_, index) => message(`history-${index}`, 'session-a'))
      .sort((left, right) => left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0);
    const store = new RuntimeStore(successfulRuntimeApi({
      getStatus: async () => ({ availability: 'ready', capabilities: [], observedAt: NOW }),
      onEvent: listener => { receive = listener; return () => {}; },
      request: async command => {
        if (command.kind === 'projection.snapshot.get') return { kind: 'projection.snapshot',
          snapshot: projectionSnapshot({ sessions: [session('session-a')], messages: history, models: [model('model-a')] }) };
        if (command.kind === 'projection.commits.read') return { kind: 'projection.commits',
          batch: readBatch(command.request.afterCursor, command.request.afterDigest, []) };
        throw new Error('unexpected command');
      }
    }));
    try {
      await store.initialize();
      expect(store.getSnapshot().lastError).toBeNull();
      await store.sessions.select('session-a');
      const before = store.getSnapshot();
      const counts = { messages: 0, sessions: 0, models: 0, decisions: 0, runs: 0, diagnostics: 0 };
      const remove = (Object.keys(counts) as (keyof typeof counts)[]).map(feature =>
        store[feature].view.subscribe(() => { counts[feature]++; }));
      for (let sequence = 1; sequence <= 100; sequence++) receive(runtimeEnvelope({
        contractVersion: '1.0', kind: 'inference.chunk.observed', sessionId: 'session-a', runId: 'live-run',
        turnId: 'live-turn', attemptId: 'live-attempt', sequence, channel: 'token', text: 'x', observedAt: NOW
      }, sequence));
      expect(counts.messages).toBe(0);
      await vi.advanceTimersByTimeAsync(16);
      expect(counts).toEqual({ messages: 1, sessions: 0, models: 0, decisions: 0, runs: 0, diagnostics: 0 });
      const after = store.getSnapshot();
      expect(after.messages).toHaveLength(count + 1);
      expect(after.messages.find(item => item.runId === 'live-run')?.content).toBe('x'.repeat(100));
      expect(after.messages.find(item => item.messageId === 'history-0')).toBe(before.messages.find(item => item.messageId === 'history-0'));
      expect(after.sessions).toBe(before.sessions);
      expect(after.models).toBe(before.models);
      expect(after.runs).toBe(before.runs);
      remove.forEach(unsubscribe => unsubscribe());
    } finally { store.dispose(); vi.useRealTimers(); }
  });
});
