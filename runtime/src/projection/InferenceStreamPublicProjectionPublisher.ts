import { createHash } from 'node:crypto';

import {
  PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION,
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  publicInferenceChunkObservedV1Schema,
  publicInferenceChunkProjectionV3Schema,
  publicInferenceStreamTerminatedV1Schema,
  publicInferenceStreamProjectionV3Schema,
  publicProjectionCanonicalIdSchema,
  type PublicInferenceChunkProjectionV3,
  type PublicInferenceStreamProjectionV3
} from '@ariadne/protocol/public';

import type {
  BoundInferenceStreamProjection,
  InferenceStreamLiveEventSink,
  InferenceStreamProjectionHead,
  InferenceStreamPublicProjectionStore
} from './InferenceStreamProjectionPorts.js';

const FLUSH_INTERVAL_MS = 25;
const MAX_RETAINED_CHUNK_BYTES = 256 * 1_024;
const MAX_RETAINED_CHUNKS = 1_024;

export interface InferenceStreamIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
}

interface MutableStreamState extends InferenceStreamIdentity {
  readonly inferenceStreamId: string;
  readonly sourceId: string;
  sourceCursor: number;
  version: number;
  nextSequence: number;
  status: PublicInferenceStreamProjectionV3['status'];
  retainedBytes: number;
  chunks: PublicInferenceChunkProjectionV3[];
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
  dirty: boolean;
  publishLiveEvents: boolean;
  liveTail: Promise<void>;
  liveFailure: unknown | null;
}

export class InferenceStreamPublicProjectionPublisher {
  public constructor(
    private readonly store: InferenceStreamPublicProjectionStore,
    private readonly liveEvents: InferenceStreamLiveEventSink,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async reconcileOpenStreams(
    resolve: (
      identity: InferenceStreamIdentity
    ) => Promise<'committed' | 'interrupted'>
  ): Promise<void> {
    const heads = await this.store.readInferenceStreamProjectionHeads();
    for (const head of heads) {
      if (head.operation !== 'upsert' || head.dto === null) {
        throw new Error('inference_stream_head_invalid');
      }
      const dto = publicInferenceStreamProjectionV3Schema.parse(head.dto);
      if (dto.status !== 'streaming') continue;
      const identity = {
        sessionId: dto.sessionId,
        runId: dto.runId,
        turnId: dto.turnId,
        attemptId: dto.attemptId
      };
      const state = await this.restore(identity, false);
      await this.terminate(state, await resolve(identity));
    }
  }

  public async bind(identityValue: InferenceStreamIdentity): Promise<BoundInferenceStreamProjection> {
    const state = await this.restore(validateIdentity(identityValue), true);
    return this.bound(state);
  }

  private async restore(
    identity: InferenceStreamIdentity,
    publishLiveEvents: boolean
  ): Promise<MutableStreamState> {
    const inferenceStreamId = streamIdFor(identity);
    const sourceId = `inference-source.${inferenceStreamId}`;
    const [head, sourceCursor] = await Promise.all([
      this.store.readInferenceStreamProjectionHead(inferenceStreamId),
      this.store.readPublicProjectionSourceCheckpoint(sourceId)
    ]);
    const state = restoreState(
      identity,
      inferenceStreamId,
      sourceId,
      sourceCursor,
      head,
      publishLiveEvents
    );
    if (state.status !== 'streaming') throw new Error('inference_stream_already_terminated');
    return state;
  }

  private bound(state: MutableStreamState): BoundInferenceStreamProjection {
    return Object.freeze({
      inferenceStreamId: state.inferenceStreamId,
      chunkObserver: Object.freeze({
        observe: (chunk: {
          readonly sequence: number;
          readonly channel: 'token' | 'reasoning';
          readonly text: string;
        }) => this.observe(state, chunk)
      }),
      terminate: (status: PublicInferenceStreamProjectionV3['status']) => (
        this.terminate(state, status)
      )
    });
  }

  private observe(
    state: MutableStreamState,
    chunk: { readonly sequence: number; readonly channel: 'token' | 'reasoning'; readonly text: string }
  ): void {
    if (state.status !== 'streaming') throw new Error('inference_stream_already_terminated');
    if (chunk.sequence !== state.nextSequence) throw new Error('inference_stream_sequence_invalid');
    const observedAt = canonicalNow(this.now);
    const parsed = publicInferenceChunkProjectionV3Schema.parse({
      ...chunk,
      observedAt
    });
    this.enqueueLiveEvent(state, publicInferenceChunkObservedV1Schema.parse({
      contractVersion: PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION,
      kind: 'inference.chunk.observed',
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: state.turnId,
      attemptId: state.attemptId,
      sequence: parsed.sequence,
      channel: parsed.channel,
      text: parsed.text,
      observedAt: parsed.observedAt
    }));
    state.chunks.push(parsed);
    state.retainedBytes += utf8Bytes(parsed.text);
    state.nextSequence += 1;
    while (
      state.chunks.length > MAX_RETAINED_CHUNKS
      || state.retainedBytes > MAX_RETAINED_CHUNK_BYTES
    ) {
      const removed = state.chunks.shift();
      if (removed === undefined) throw new Error('inference_stream_retention_invalid');
      state.retainedBytes -= utf8Bytes(removed.text);
    }
    state.dirty = true;
    if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.enqueueFlush(state);
      }, FLUSH_INTERVAL_MS);
      state.timer.unref?.();
    }
  }

  private async terminate(
    state: MutableStreamState,
    status: PublicInferenceStreamProjectionV3['status']
  ): Promise<void> {
    if (status === 'streaming') throw new Error('inference_stream_terminal_state_invalid');
    if (state.status !== 'streaming') {
      if (state.status === status) return state.tail;
      throw new Error('inference_stream_terminal_state_conflict');
    }
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    this.enqueueFlush(state);
    await state.tail;
    state.status = status;
    state.dirty = true;
    this.enqueueFlush(state);
    await state.tail;
    this.enqueueLiveEvent(state, publicInferenceStreamTerminatedV1Schema.parse({
      contractVersion: PUBLIC_INFERENCE_STREAM_CONTRACT_VERSION,
      kind: 'inference.stream.terminated',
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: state.turnId,
      attemptId: state.attemptId,
      finalSequence: state.nextSequence - 1,
      state: status,
      occurredAt: canonicalNow(this.now)
    }));
    await state.liveTail;
    if (state.liveFailure !== null) throw state.liveFailure;
  }

  private enqueueLiveEvent(
    state: MutableStreamState,
    event: ReturnType<typeof publicInferenceChunkObservedV1Schema.parse>
      | ReturnType<typeof publicInferenceStreamTerminatedV1Schema.parse>
  ): void {
    if (!state.publishLiveEvents) return;
    const aggregateVersion = event.kind === 'inference.chunk.observed'
      ? event.sequence
      : event.finalSequence + 1;
    state.liveTail = state.liveTail.then(async () => {
      if (state.liveFailure !== null) return;
      try {
        await this.liveEvents.append({
          eventId: `${state.inferenceStreamId}.${event.kind}.${String(aggregateVersion)}`,
          aggregateType: 'inference_stream',
          aggregateId: state.inferenceStreamId,
          aggregateVersion,
          correlationId: state.runId,
          occurredAt: event.kind === 'inference.chunk.observed'
            ? event.observedAt
            : event.occurredAt,
          event
        });
      } catch (error) {
        state.liveFailure = error;
      }
    });
  }

  private enqueueFlush(state: MutableStreamState): void {
    if (!state.dirty) return;
    state.dirty = false;
    const nextVersion = state.version + 1;
    const nextSourceCursor = state.sourceCursor + 1;
    state.version = nextVersion;
    state.sourceCursor = nextSourceCursor;
    const dto = snapshotDto(state, canonicalNow(this.now), nextVersion);
    state.tail = state.tail.then(async () => {
      await this.store.append({
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        eventId: `${state.inferenceStreamId}.v${String(dto.version)}`,
        sourceId: state.sourceId,
        sourceCursor: nextSourceCursor,
        occurredAt: dto.updatedAt,
        changes: [{
          feature: 'inference_streams',
          aggregateId: state.inferenceStreamId,
          aggregateVersion: dto.version,
          operation: 'upsert',
          projectedAt: dto.updatedAt,
          dto
        }]
      });
    });
  }
}

function restoreState(
  identity: InferenceStreamIdentity,
  inferenceStreamId: string,
  sourceId: string,
  sourceCursor: number,
  head: InferenceStreamProjectionHead | null,
  publishLiveEvents: boolean
): MutableStreamState {
  if (head === null) {
    if (sourceCursor !== 0) throw new Error('inference_stream_checkpoint_without_head');
    return {
      ...identity,
      inferenceStreamId,
      sourceId,
      sourceCursor: 0,
      version: 0,
      nextSequence: 1,
      status: 'streaming',
      retainedBytes: 0,
      chunks: [],
      tail: Promise.resolve(),
      dirty: false,
      publishLiveEvents,
      liveTail: Promise.resolve(),
      liveFailure: null
    };
  }
  if (head.operation !== 'upsert' || head.dto === null) {
    throw new Error('inference_stream_head_invalid');
  }
  const dto = publicInferenceStreamProjectionV3Schema.parse(head.dto);
  if (
    head.aggregateId !== inferenceStreamId
    || head.aggregateVersion !== dto.version
    || dto.runId !== identity.runId
    || dto.sessionId !== identity.sessionId
    || dto.turnId !== identity.turnId
    || dto.attemptId !== identity.attemptId
    || sourceCursor !== dto.version
  ) throw new Error('inference_stream_head_identity_drift');
  return {
    ...identity,
    inferenceStreamId,
    sourceId,
    sourceCursor,
    version: dto.version,
    nextSequence: dto.finalSequence + 1,
    status: dto.status,
    retainedBytes: dto.chunks.reduce((total, chunk) => total + utf8Bytes(chunk.text), 0),
    chunks: [...dto.chunks],
    tail: Promise.resolve(),
    dirty: false,
    publishLiveEvents,
    liveTail: Promise.resolve(),
    liveFailure: null
  };
}

function snapshotDto(
  state: MutableStreamState,
  updatedAt: string,
  version: number
): PublicInferenceStreamProjectionV3 {
  return publicInferenceStreamProjectionV3Schema.parse({
    inferenceStreamId: state.inferenceStreamId,
    sessionId: state.sessionId,
    runId: state.runId,
    turnId: state.turnId,
    attemptId: state.attemptId,
    version,
    status: state.status,
    retainedFromSequence: state.chunks[0]?.sequence ?? state.nextSequence,
    finalSequence: state.nextSequence - 1,
    chunks: state.chunks,
    updatedAt
  });
}

function validateIdentity(identity: InferenceStreamIdentity): InferenceStreamIdentity {
  return Object.freeze({
    sessionId: publicProjectionCanonicalIdSchema.parse(identity.sessionId),
    runId: publicProjectionCanonicalIdSchema.parse(identity.runId),
    turnId: publicProjectionCanonicalIdSchema.parse(identity.turnId),
    attemptId: publicProjectionCanonicalIdSchema.parse(identity.attemptId)
  });
}

function streamIdFor(identity: InferenceStreamIdentity): string {
  return `inference.${createHash('sha256')
    .update(`${identity.runId}\0${identity.turnId}\0${identity.attemptId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('inference_stream_clock_invalid');
  }
  return value.toISOString();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
