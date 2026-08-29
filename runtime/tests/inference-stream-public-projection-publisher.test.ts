import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { InferenceStreamPublicProjectionPublisher } from '../src/projection/InferenceStreamPublicProjectionPublisher.js';

const roots: string[] = [];
const stores = new Set<SqlitePublicProjectionStore>();
const identity = { runId: 'run-1', turnId: 'turn-1', attemptId: 'attempt-1' };

afterEach(async () => {
  await Promise.all([...stores].map((store) => store.close().catch(() => undefined)));
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('InferenceStreamPublicProjectionPublisher', () => {
  it('commits one attempt-scoped chunk snapshot and a separate terminal version', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const publisher = new InferenceStreamPublicProjectionPublisher(
      store,
      () => new Date('2026-08-28T00:00:00.000Z')
    );
    const stream = await publisher.bind(identity);
    stream.chunkObserver.observe({ sequence: 1, channel: 'reasoning', text: 'why' });
    stream.chunkObserver.observe({ sequence: 2, channel: 'token', text: 'answer' });
    await stream.terminate('committed');

    const snapshot = await store.snapshot();
    expect(snapshot.inferenceStreams).toEqual([{
      inferenceStreamId: stream.inferenceStreamId,
      ...identity,
      version: 2,
      status: 'committed',
      retainedFromSequence: 1,
      finalSequence: 2,
      chunks: [
        {
          sequence: 1,
          channel: 'reasoning',
          text: 'why',
          observedAt: '2026-08-28T00:00:00.000Z'
        },
        {
          sequence: 2,
          channel: 'token',
          text: 'answer',
          observedAt: '2026-08-28T00:00:00.000Z'
        }
      ],
      updatedAt: '2026-08-28T00:00:00.000Z'
    }]);
    await expect(publisher.bind(identity)).rejects.toThrow(
      'inference_stream_already_terminated'
    );
  });

  it('fails closed on sequence drift and contradictory terminal state', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const stream = await new InferenceStreamPublicProjectionPublisher(store).bind(identity);

    expect(() => stream.chunkObserver.observe({
      sequence: 2,
      channel: 'token',
      text: 'gap'
    })).toThrow('inference_stream_sequence_invalid');
    stream.chunkObserver.observe({ sequence: 1, channel: 'token', text: 'partial' });
    await stream.terminate('interrupted');
    await expect(stream.terminate('committed')).rejects.toThrow(
      'inference_stream_terminal_state_conflict'
    );
  });

  it('retains a bounded suffix while preserving the absolute sequence', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const stream = await new InferenceStreamPublicProjectionPublisher(store).bind(identity);
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      stream.chunkObserver.observe({
        sequence,
        channel: 'token',
        text: 'x'.repeat(32 * 1_024)
      });
    }
    await stream.terminate('interrupted');

    const projected = (await store.snapshot()).inferenceStreams[0]!;
    expect(projected.finalSequence).toBe(9);
    expect(projected.retainedFromSequence).toBe(2);
    expect(projected.chunks).toHaveLength(8);
    expect(projected.chunks[0]?.sequence).toBe(2);
  });

  it('reconciles a durable open stream to interrupted after restart', async () => {
    const store = track(new SqlitePublicProjectionStore(tempRoot()));
    const first = new InferenceStreamPublicProjectionPublisher(store);
    const stream = await first.bind(identity);
    stream.chunkObserver.observe({ sequence: 1, channel: 'token', text: 'partial' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await store.snapshot()).inferenceStreams[0]?.status).toBe('streaming');

    const reopened = new InferenceStreamPublicProjectionPublisher(store);
    const resolve = async () => 'interrupted' as const;
    await reopened.reconcileOpenStreams(resolve);

    expect((await store.snapshot()).inferenceStreams[0]).toMatchObject({
      status: 'interrupted',
      finalSequence: 1,
      chunks: [{ text: 'partial' }]
    });
  });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-inference-projection-'));
  roots.push(root);
  return root;
}

function track(store: SqlitePublicProjectionStore): SqlitePublicProjectionStore {
  stores.add(store);
  return store;
}
