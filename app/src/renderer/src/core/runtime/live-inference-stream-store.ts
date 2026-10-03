import type { PublicInferenceStreamProjectionV3, RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { LiveInferenceAttempt } from './live-inference-attempt';

/** Ephemeral suffixes joined to durable attempt heads; never a recovery authority. */
export class LiveInferenceStreamStore {
  private static readonly MAX_SETTLED_REASONING_STREAMS = 64;
  private readonly attempts = new Map<string, LiveInferenceAttempt>();
  private readonly settledReasoningIds: string[] = [];
  private settledRuns: ReadonlySet<string> = new Set();
  private snapshot: readonly PublicInferenceStreamProjectionV3[] = [];

  accept(envelope: RuntimeEventEnvelope): boolean {
    const event = envelope.event;
    if (event.kind !== 'inference.chunk.observed' && event.kind !== 'inference.stream.terminated') return false;
    if (envelope.aggregateType !== 'inference_stream') throw new Error('live_inference_stream_aggregate_type_invalid');
    const expectedVersion = event.kind === 'inference.chunk.observed' ? event.sequence : event.finalSequence + 1;
    if (envelope.aggregateVersion !== expectedVersion) throw new Error('live_inference_stream_aggregate_version_invalid');
    if (this.settledRuns.has(event.runId)) return true;
    const attempt = this.attempts.get(envelope.aggregateId) ?? new LiveInferenceAttempt(envelope.aggregateId, event);
    attempt.accept(event);
    this.attempts.set(envelope.aggregateId, attempt);
    return true;
  }

  reconcile(heads: readonly PublicInferenceStreamProjectionV3[]): void {
    for (const head of heads) {
      if (this.settledRuns.has(head.runId)) continue;
      const attempt = this.attempts.get(head.inferenceStreamId) ?? new LiveInferenceAttempt(head.inferenceStreamId, head);
      attempt.reconcile(head);
      this.attempts.set(head.inferenceStreamId, attempt);
    }
  }

  get needsSynchronization(): boolean {
    return [...this.attempts.values()].some(attempt => attempt.needsSynchronization);
  }

  get hasActiveStreams(): boolean {
    return [...this.attempts.values()].some(attempt => attempt.head?.status === 'streaming' || attempt.needsSynchronization);
  }

  getSnapshot(): readonly PublicInferenceStreamProjectionV3[] {
    const heads = [...this.attempts.values()].flatMap(attempt => attempt.head === undefined ? [] : [attempt.head]);
    if (heads.length !== this.snapshot.length || heads.some((head, index) => head !== this.snapshot[index])) {
      this.snapshot = heads;
    }
    return this.snapshot;
  }

  discardRuns(runIds: ReadonlySet<string>): void {
    this.settledRuns = runIds;
    for (const [id, attempt] of this.attempts) {
      if (!runIds.has(attempt.identity.runId)) continue;
      const hasReasoning = attempt.head?.chunks.some((chunk) => chunk.channel === 'reasoning') ?? false;
      if (!hasReasoning) {
        this.attempts.delete(id);
        continue;
      }
      if (!this.settledReasoningIds.includes(id)) this.settledReasoningIds.push(id);
    }
    while (this.settledReasoningIds.length > LiveInferenceStreamStore.MAX_SETTLED_REASONING_STREAMS) {
      const expired = this.settledReasoningIds.shift();
      if (expired !== undefined) this.attempts.delete(expired);
    }
  }

  clear(): void {
    this.attempts.clear();
    this.settledReasoningIds.length = 0;
    this.settledRuns = new Set();
  }
}
