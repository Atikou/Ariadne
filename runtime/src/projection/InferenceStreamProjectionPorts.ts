import type {
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
