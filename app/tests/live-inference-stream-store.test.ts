import { describe, expect, it } from 'vitest';
import type { PublicInferenceStreamProjectionV3, PublicInferenceStreamEventV1 } from '@ariadne/protocol/public';
import { LiveInferenceStreamStore } from '../src/renderer/src/core/runtime/live-inference-stream-store';
import { runtimeEnvelope } from './runtime-event-fixture';

const identity = { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', attemptId: 'attempt-a' };
const at = '2026-09-05T00:00:00.000Z';
const streamId = 'run-a:turn-a:attempt-a';
function chunk(sequence: number, text = String(sequence), attemptId = identity.attemptId) {
  return runtimeEnvelope({ ...identity, attemptId, contractVersion: '1.0', kind: 'inference.chunk.observed',
    sequence, channel: 'token', text, observedAt: at }, sequence);
}
function terminal(finalSequence: number, state: 'committed' | 'interrupted' = 'committed') {
  return runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.stream.terminated',
    finalSequence, state, occurredAt: at }, finalSequence + 1);
}
function durable(finalSequence: number, retainedFromSequence = 1,
  status: PublicInferenceStreamProjectionV3['status'] = 'streaming'): PublicInferenceStreamProjectionV3 {
  return { ...identity, inferenceStreamId: streamId, version: 1, status, finalSequence, retainedFromSequence,
    chunks: Array.from({ length: finalSequence - retainedFromSequence + 1 }, (_, i) => ({
      sequence: i + retainedFromSequence, channel: 'token' as const,
      text: String(i + retainedFromSequence), observedAt: at
    })), updatedAt: at };
}
const content = (store: LiveInferenceStreamStore) => store.getSnapshot()[0]?.chunks.map(c => c.text).join('');

describe('live inference and durable head reconciliation', () => {
  it('buffers a mid-attempt subscription until the durable prefix arrives', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(3));
    expect(store.needsSynchronization).toBe(true);
    expect(store.getSnapshot()).toEqual([]);
    store.reconcile([durable(2)]);
    expect(content(store)).toBe('123');
    expect(store.needsSynchronization).toBe(false);
    store.accept(chunk(4));
    expect(content(store)).toBe('1234');
  });

  it('repairs a gap from the durable head and drains the buffered suffix', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(chunk(3));
    store.accept(chunk(4));
    expect(content(store)).toBe('1');
    store.reconcile([durable(2)]);
    expect(content(store)).toBe('1234');
    store.reconcile([durable(5)]);
    expect(content(store)).toBe('12345');
  });

  it('accepts exact duplicate delivery and rejects conflicting duplicates and identities', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(chunk(1));
    store.accept(chunk(3));
    store.accept(chunk(3));
    expect(() => store.accept(chunk(1, 'conflict'))).toThrow('chunk_conflict');
    expect(() => store.accept(chunk(3, 'conflict'))).toThrow('chunk_conflict');
    expect(() => store.accept({ ...chunk(2), event: { ...chunk(2).event, sessionId: 'wrong' } as PublicInferenceStreamEventV1 }))
      .toThrow('identity_drift');
    expect(() => store.reconcile([{ ...durable(2), attemptId: 'wrong' }])).toThrow('identity_drift');
    expect(content(store)).toBe('1');
  });

  it.each(['committed', 'interrupted'] as const)('retains %s across stale durable heads and duplicate terminal events', state => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(terminal(1, state));
    store.reconcile([durable(1)]);
    store.accept(terminal(1, state));
    store.accept(chunk(1));
    expect(store.getSnapshot()[0]?.status).toBe(state);
    expect(() => store.accept(chunk(2))).toThrow('already_terminated');
  });

  it('recovers a terminal received across a gap and honors durable interruption', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(terminal(3));
    expect(store.needsSynchronization).toBe(true);
    store.reconcile([durable(3)]);
    expect(store.getSnapshot()[0]?.status).toBe('committed');
    store.clear();
    store.accept(chunk(1));
    store.accept(chunk(3));
    store.reconcile([durable(1, 1, 'interrupted')]);
    expect(store.getSnapshot()[0]?.status).toBe('interrupted');
    expect(store.needsSynchronization).toBe(false);
  });

  it('uses the retained durable suffix after a long gap without fabricating missing text', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(chunk(1003));
    store.reconcile([durable(1002, 1000)]);
    expect(content(store)).toBe('1000100110021003');
    expect(store.getSnapshot()[0]?.retainedFromSequence).toBe(1000);
  });

  it('bounds pending chunks and recovers when the durable suffix overtakes discarded pending data', () => {
    const store = new LiveInferenceStreamStore();
    for (let n = 2; n <= 1100; n++) store.accept(chunk(n));
    store.reconcile([durable(1099, 1098)]);
    expect(content(store)).toBe('109810991100');
    expect(store.needsSynchronization).toBe(false);
  });

  it('separates attempts, suppresses late settled-run events, and resets with the Runtime epoch', () => {
    const store = new LiveInferenceStreamStore();
    store.accept(chunk(1));
    store.accept(chunk(1, 'next', 'attempt-b'));
    expect(store.getSnapshot()).toHaveLength(2);
    store.discardRuns(new Set([identity.runId]));
    store.accept(chunk(2));
    expect(store.getSnapshot()).toEqual([]);
    store.clear();
    store.accept(chunk(2));
    store.reconcile([durable(1)]);
    expect(content(store)).toBe('12');
  });

  it('retains a committed reasoning stream so the final row can show the thought process', () => {
    const store = new LiveInferenceStreamStore();
    const reasoning = runtimeEnvelope({ ...identity, contractVersion: '1.0', kind: 'inference.chunk.observed',
      sequence: 1, channel: 'reasoning', text: '先检查约束', observedAt: at }, 1);
    store.accept(reasoning);
    store.accept(terminal(1));
    store.discardRuns(new Set([identity.runId]));
    expect(store.getSnapshot()[0]?.status).toBe('committed');
    expect(store.getSnapshot()[0]?.chunks[0]?.text).toBe('先检查约束');
  });
});
