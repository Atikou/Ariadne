import type {
  PublicInferenceStreamEventV1,
  PublicInferenceStreamProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';

import type { PublicProjectionCommitSink } from './PublicProjectionPorts.js';

export type InferenceStreamProjectionHead = Pick<
  Extract<PublicProjectionChangeV3, { feature: 'inference_streams' }>,
  'aggregateId' | 'aggregateVersion' | 'operation' | 'dto'
>;

export interface InferenceStreamPublicProjectionStore
extends PublicProjectionCommitSink {
  readPublicProjectionSourceCheckpoint(sourceId: string): Promise<number>;
  readInferenceStreamProjectionHead(
    inferenceStreamId: string
  ): Promise<InferenceStreamProjectionHead | null>;
  readInferenceStreamProjectionHeads(): Promise<readonly InferenceStreamProjectionHead[]>;
}

export interface InferenceStreamLiveEventAppend {
  readonly eventId: string;
  readonly aggregateType: 'inference_stream';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly event: PublicInferenceStreamEventV1;
}

export interface InferenceStreamLiveEventSink {
  append(event: InferenceStreamLiveEventAppend): Promise<void>;
}

export interface BoundInferenceStreamProjection {
  readonly inferenceStreamId: string;
  readonly chunkObserver: {
    observe(chunk: {
      readonly sequence: number;
      readonly channel: 'token' | 'reasoning';
      readonly text: string;
    }): void;
  };
  terminate(state: PublicInferenceStreamProjectionV3['status']): Promise<void>;
}
