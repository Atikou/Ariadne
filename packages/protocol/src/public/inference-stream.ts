import { z } from 'zod';

import {
  publicProjectionCanonicalIdSchema,
  publicProjectionCanonicalTimestampSchema
} from './projection.js';

export const PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION = '1.0' as const;
export const PUBLIC_INFERENCE_CHUNK_MAX_BYTES = 32 * 1_024;

const positiveSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const boundedChunkTextSchema = z.string().min(1).max(PUBLIC_INFERENCE_CHUNK_MAX_BYTES)
  .superRefine((value, context) => {
    if (Buffer.byteLength(value, 'utf8') > PUBLIC_INFERENCE_CHUNK_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Inference chunk exceeds ${String(PUBLIC_INFERENCE_CHUNK_MAX_BYTES)} UTF-8 bytes.`
      });
    }
  });

export const publicInferenceStreamIdentitySchema = z.object({
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  turnId: publicProjectionCanonicalIdSchema,
  attemptId: publicProjectionCanonicalIdSchema
}).strict();
export type PublicInferenceStreamIdentity = z.infer<
  typeof publicInferenceStreamIdentitySchema
>;

export const publicInferenceChunkObservedSchema = z.object({
  contractVersion: z.literal(PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION),
  kind: z.literal('inference.chunk.observed'),
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  turnId: publicProjectionCanonicalIdSchema,
  attemptId: publicProjectionCanonicalIdSchema,
  sequence: positiveSequenceSchema,
  channel: z.enum(['token', 'reasoning']),
  text: boundedChunkTextSchema,
  observedAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicInferenceChunkObserved = z.infer<
  typeof publicInferenceChunkObservedSchema
>;

export const publicInferenceStreamTerminatedSchema = z.object({
  contractVersion: z.literal(PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION),
  kind: z.literal('inference.stream.terminated'),
  sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema,
  turnId: publicProjectionCanonicalIdSchema,
  attemptId: publicProjectionCanonicalIdSchema,
  finalSequence: nonnegativeSequenceSchema,
  state: z.enum(['committed', 'interrupted']),
  occurredAt: publicProjectionCanonicalTimestampSchema
}).strict();
export type PublicInferenceStreamTerminated = z.infer<
  typeof publicInferenceStreamTerminatedSchema
>;

export const publicInferenceStreamEventSchema = z.discriminatedUnion('kind', [
  publicInferenceChunkObservedSchema,
  publicInferenceStreamTerminatedSchema
]);
export type PublicInferenceStreamEvent = z.infer<
  typeof publicInferenceStreamEventSchema
>;

export interface PublicInferenceStreamReplayState
extends PublicInferenceStreamIdentity {
  readonly nextSequence: number;
  readonly terminalState?: PublicInferenceStreamTerminated['state'];
}

/**
 * Applies an event to one exact attempt. This is deliberately stricter than a
 * UI reducer: replay must fail closed on identity drift, gaps, duplicates, or
 * events observed after a terminal state.
 */
export function replayPublicInferenceStreamEvent(
  state: PublicInferenceStreamReplayState | undefined,
  input: unknown
): PublicInferenceStreamReplayState {
  const event = publicInferenceStreamEventSchema.parse(input);
  const current = state ?? {
    sessionId: event.sessionId,
    runId: event.runId,
    turnId: event.turnId,
    attemptId: event.attemptId,
    nextSequence: 1
  };

  if (
    current.sessionId !== event.sessionId
    || current.runId !== event.runId
    || current.turnId !== event.turnId
    || current.attemptId !== event.attemptId
  ) {
    throw new Error('public_inference_stream_identity_drift');
  }
  if (current.terminalState !== undefined) {
    throw new Error('public_inference_stream_already_terminated');
  }

  if (event.kind === 'inference.chunk.observed') {
    if (event.sequence !== current.nextSequence) {
      throw new Error('public_inference_stream_sequence_invalid');
    }
    return { ...current, nextSequence: current.nextSequence + 1 };
  }

  if (event.finalSequence !== current.nextSequence - 1) {
    throw new Error('public_inference_stream_terminal_sequence_invalid');
  }
  return { ...current, terminalState: event.state };
}
