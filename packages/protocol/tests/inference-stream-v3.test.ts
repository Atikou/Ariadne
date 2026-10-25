import { describe, expect, it } from 'vitest';

import {
  PUBLIC_INFERENCE_CHUNK_MAX_BYTES,
  publicInferenceChunkObservedSchema,
  replayPublicInferenceStreamEvent
} from '../src/public/inference-stream.js';
import { runtimeEventEnvelopeSchema } from '../src/public.js';

const observedAt = '2026-08-28T00:00:00.000Z';

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    kind: 'inference.chunk.observed',
    sessionId: 'session-1',
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
    sessionId: 'session-1',
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
  it('is carried by the Runtime public event envelope', () => {
    expect(runtimeEventEnvelopeSchema.parse({
      eventId: 'inference.event.1',
      cursor: 1,
      schemaVersion: '2.0',
      aggregateType: 'inference_stream',
      aggregateId: 'inference.stream.1',
      aggregateVersion: 1,
      occurredAt: observedAt,
      event: chunk()
    }).event).toMatchObject({
      kind: 'inference.chunk.observed',
      sequence: 1
    });
  });

  it('replays one exact attempt in contiguous sequence', () => {
    const first = replayPublicInferenceStreamEvent(undefined, chunk());
    const second = replayPublicInferenceStreamEvent(first, chunk({
      sequence: 2,
      channel: 'reasoning',
      text: 'thinking'
    }));
    const completed = replayPublicInferenceStreamEvent(second, terminated({
      finalSequence: 2
    }));

    expect(completed).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      nextSequence: 3,
      terminalState: 'committed'
    });
  });

  it('rejects gaps, duplicates, identity drift, and contradictory terminal events', () => {
    const first = replayPublicInferenceStreamEvent(undefined, chunk());

    expect(() => replayPublicInferenceStreamEvent(first, chunk({ sequence: 3 })))
      .toThrow('public_inference_stream_sequence_invalid');
    expect(() => replayPublicInferenceStreamEvent(first, chunk()))
      .toThrow('public_inference_stream_sequence_invalid');
    expect(() => replayPublicInferenceStreamEvent(first, chunk({ attemptId: 'attempt-2' })))
      .toThrow('public_inference_stream_identity_drift');
    expect(() => replayPublicInferenceStreamEvent(first, terminated({ finalSequence: 0 })))
      .toThrow('public_inference_stream_terminal_sequence_invalid');

    const completed = replayPublicInferenceStreamEvent(first, terminated());
    expect(() => replayPublicInferenceStreamEvent(completed, terminated({ state: 'interrupted' })))
      .toThrow('public_inference_stream_already_terminated');
  });

  it('bounds chunk payload by UTF-8 bytes, not JavaScript code units', () => {
    expect(publicInferenceChunkObservedSchema.safeParse(chunk({
      text: 'x'.repeat(PUBLIC_INFERENCE_CHUNK_MAX_BYTES)
    })).success).toBe(true);
    expect(publicInferenceChunkObservedSchema.safeParse(chunk({
      text: '中'.repeat(Math.floor(PUBLIC_INFERENCE_CHUNK_MAX_BYTES / 3) + 1)
    })).success).toBe(false);
  });

  it('rejects empty chunks, invalid canonical identities, and extra fields', () => {
    expect(publicInferenceChunkObservedSchema.safeParse(chunk({ text: '' })).success)
      .toBe(false);
    expect(publicInferenceChunkObservedSchema.safeParse(chunk({ runId: 'run/1' })).success)
      .toBe(false);
    expect(publicInferenceChunkObservedSchema.safeParse(chunk({ hidden: true })).success)
      .toBe(false);
  });
});
