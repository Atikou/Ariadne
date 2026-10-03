import type {
  PublicInferenceStreamEventV1, PublicInferenceStreamIdentityV1,
  PublicInferenceStreamProjectionV3, PublicInferenceStreamTerminatedV1
} from '@ariadne/protocol/public';

type Stream = PublicInferenceStreamProjectionV3;
type Chunk = Stream['chunks'][number];
const MAX_CHUNKS = 1_024;
const MAX_BYTES = 256 * 1_024;
const encoder = new TextEncoder();

/** Joins only a contiguous suffix. Gaps await the existing durable Projection protocol. */
export class LiveInferenceAttempt {
  head: Stream | undefined;
  private readonly pending = new Map<number, Chunk>();
  private pendingBytes = 0;
  private terminal: PublicInferenceStreamTerminatedV1 | undefined;

  constructor(readonly id: string, readonly identity: PublicInferenceStreamIdentityV1) {}

  get needsSynchronization(): boolean {
    return this.pending.size > 0 || (this.terminal !== undefined && this.head?.status === 'streaming')
      || (this.terminal !== undefined && this.head === undefined);
  }

  accept(event: PublicInferenceStreamEventV1): void {
    this.assertIdentity(event);
    const head = this.head;
    if (event.kind === 'inference.stream.terminated') {
      if (head !== undefined && head.status !== 'streaming') {
        if (head.status !== event.state || head.finalSequence !== event.finalSequence) {
          throw new Error('live_inference_stream_terminal_conflict');
        }
        return;
      }
      if (
        (head !== undefined && event.finalSequence < head.finalSequence)
        || [...this.pending.keys()].some(sequence => sequence > event.finalSequence)
        || (this.terminal !== undefined && (this.terminal.state !== event.state
          || this.terminal.finalSequence !== event.finalSequence))
      ) throw new Error('live_inference_stream_terminal_conflict');
      this.terminal = event;
    } else {
      const chunk = { sequence: event.sequence, channel: event.channel, text: event.text, observedAt: event.observedAt };
      if (head !== undefined && event.sequence <= head.finalSequence) {
        assertSameChunk(head.chunks.find(item => item.sequence === event.sequence), chunk);
        return; // Already covered by the head, including an expired retained prefix.
      }
      if ((head !== undefined && head.status !== 'streaming')
        || (this.terminal !== undefined && event.sequence > this.terminal.finalSequence)) {
        throw new Error('live_inference_stream_already_terminated');
      }
      const existing = this.pending.get(event.sequence);
      assertSameChunk(existing, chunk);
      if (existing !== undefined) return;
      this.pending.set(event.sequence, chunk);
      this.pendingBytes += bytes(chunk);
      // Keep a bounded newest suffix; only a durable head can bridge discarded data.
      while (this.pending.size > MAX_CHUNKS || this.pendingBytes > MAX_BYTES) {
        this.removePending(Math.min(...this.pending.keys()));
      }
    }
    this.drain();
  }

  reconcile(durable: Stream): void {
    this.assertIdentity(durable);
    const previous = this.head;
    const previousChunks = new Map(previous?.chunks.map(chunk => [chunk.sequence, chunk]));
    for (const chunk of durable.chunks) {
      assertSameChunk(this.pending.get(chunk.sequence), chunk);
      assertSameChunk(previousChunks.get(chunk.sequence), chunk);
    }
    if (this.terminal !== undefined && durable.finalSequence > this.terminal.finalSequence) {
      throw new Error('live_inference_stream_terminal_conflict');
    }
    // A durable terminal head wins, even over an uncommitted live suffix.
    if (durable.status !== 'streaming') {
      this.head = durable;
      this.pending.clear();
      this.pendingBytes = 0;
      this.terminal = undefined;
      return;
    }
    if (previous !== undefined && previous.status !== 'streaming') return;
    if (previous === undefined || durable.finalSequence >= previous.finalSequence) this.head = durable;
    for (const sequence of this.pending.keys()) {
      if (sequence <= this.head!.finalSequence) this.removePending(sequence);
    }
    this.drain();
  }

  private drain(): void {
    let next = (this.head?.finalSequence ?? 0) + 1;
    const suffix: Chunk[] = [];
    while (this.pending.has(next)) {
      suffix.push(this.pending.get(next)!);
      this.removePending(next++);
    }
    if (suffix.length > 0) {
      const chunks = [...(this.head?.chunks ?? []), ...suffix];
      let retainedBytes = chunks.reduce((total, chunk) => total + bytes(chunk), 0);
      while (chunks.length > MAX_CHUNKS || retainedBytes > MAX_BYTES) retainedBytes -= bytes(chunks.shift()!);
      this.head = {
        sessionId: this.identity.sessionId, runId: this.identity.runId,
        turnId: this.identity.turnId, attemptId: this.identity.attemptId,
        inferenceStreamId: this.id, version: this.head?.version ?? 1, status: 'streaming',
        chunks, finalSequence: next - 1, retainedFromSequence: chunks[0]?.sequence ?? next,
        updatedAt: suffix.at(-1)!.observedAt
      };
    }
    if (this.terminal !== undefined && this.terminal.finalSequence === (this.head?.finalSequence ?? 0)) {
      this.head = {
        sessionId: this.identity.sessionId, runId: this.identity.runId,
        turnId: this.identity.turnId, attemptId: this.identity.attemptId,
        inferenceStreamId: this.id, version: this.head?.version ?? 1, status: this.terminal.state,
        chunks: this.head?.chunks ?? [], finalSequence: this.terminal.finalSequence,
        retainedFromSequence: this.head?.retainedFromSequence ?? 1, updatedAt: this.terminal.occurredAt
      };
      this.terminal = undefined;
    }
  }

  private removePending(sequence: number): void {
    const chunk = this.pending.get(sequence);
    if (chunk === undefined) return;
    this.pendingBytes -= bytes(chunk);
    this.pending.delete(sequence);
  }

  private assertIdentity(value: PublicInferenceStreamIdentityV1): void {
    if (this.identity.sessionId !== value.sessionId || this.identity.runId !== value.runId
      || this.identity.turnId !== value.turnId || this.identity.attemptId !== value.attemptId) {
      throw new Error('live_inference_stream_identity_drift');
    }
  }
}

function assertSameChunk(previous: Chunk | undefined, next: Chunk): void {
  if (previous !== undefined && (previous.text !== next.text || previous.channel !== next.channel
    || previous.observedAt !== next.observedAt)) throw new Error('live_inference_stream_chunk_conflict');
}

function bytes(chunk: Chunk): number { return encoder.encode(chunk.text).byteLength; }
