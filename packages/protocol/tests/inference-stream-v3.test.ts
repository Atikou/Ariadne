import { describe, expect, it } from 'vitest';

import {
  PUBLIC_INFERENCE_CHUNK_MAX_BYTES,
  publicInferenceChunkObservedV1Schema,
  replayPublicInferenceStreamEventV1
} from '../src/public/inference-stream-v3.js';

const observedAt = '2026-08-28T00:00:00.000Z';

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    kind: 'inference.chunk.observed',
    runId: 'run-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    sequence: 1,
    channel: 'token',
    text: 'hello',
    observedAt,
    ...overrides
  };
}

function terminated(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    kind: 'inference.stream.terminated',
    runId: 'run-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    finalSequence: 1,
    state: 'committed',
    occurredAt: observedAt,
    ...overrides
  };
}

describe('public inference stream v1', () => {
  it('replays one exact attempt in contiguous sequence', () => {
    const first = replayPublicInferenceStreamEventV1(undefined, chunk());
    const second = replayPublicInferenceStreamEventV1(first, chunk({
      sequence: 2,
      channel: 'reasoning',
      text: 'thinking'
    }));
    const completed = replayPublicInferenceStreamEventV1(second, terminated({
      finalSequence: 2
    }));

    expect(completed).toEqual({
      runId: 'run-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      nextSequence: 3,
      terminalState: 'committed'
    });
  });

  it('rejects gaps, duplicates, identity drift, and contradictory terminal events', () => {
    const first = replayPublicInferenceStreamEventV1(undefined, chunk());

    expect(() => replayPublicInferenceStreamEventV1(first, chunk({ sequence: 3 })))
      .toThrow('public_inference_stream_sequence_invalid');
    expect(() => replayPublicInferenceStreamEventV1(first, chunk()))
      .toThrow('public_inference_stream_sequence_invalid');
    expect(() => replayPublicInferenceStreamEventV1(first, chunk({ attemptId: 'attempt-2' })))
      .toThrow('public_inference_stream_identity_drift');
    expect(() => replayPublicInferenceStreamEventV1(first, terminated({ finalSequence: 0 })))
      .toThrow('public_inference_stream_terminal_sequence_invalid');

    const completed = replayPublicInferenceStreamEventV1(first, terminated());
    expect(() => replayPublicInferenceStreamEventV1(completed, terminated({ state: 'interrupted' })))
      .toThrow('public_inference_stream_already_terminated');
  });

  it('bounds chunk payload by UTF-8 bytes, not JavaScript code units', () => {
    expect(publicInferenceChunkObservedV1Schema.safeParse(chunk({
      text: 'x'.repeat(PUBLIC_INFERENCE_CHUNK_MAX_BYTES)
    })).success).toBe(true);
    expect(publicInferenceChunkObservedV1Schema.safeParse(chunk({
      text: '中'.repeat(Math.floor(PUBLIC_INFERENCE_CHUNK_MAX_BYTES / 3) + 1)
    })).success).toBe(false);
  });

  it('rejects empty chunks, invalid canonical identities, and extra fields', () => {
    expect(publicInferenceChunkObservedV1Schema.safeParse(chunk({ text: '' })).success)
      .toBe(false);
    expect(publicInferenceChunkObservedV1Schema.safeParse(chunk({ runId: 'run/1' })).success)
      .toBe(false);
    expect(publicInferenceChunkObservedV1Schema.safeParse(chunk({ hidden: true })).success)
      .toBe(false);
  });
});
