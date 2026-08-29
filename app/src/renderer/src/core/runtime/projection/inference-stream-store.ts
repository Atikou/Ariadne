import type {
  PublicInferenceStreamProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type InferenceStreamProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'inference_streams' }
>;

export class InferenceStreamStore
extends ProjectionFeatureStore<PublicInferenceStreamProjectionV3> {
  constructor() {
    super((stream) => stream.inferenceStreamId);
  }
}
