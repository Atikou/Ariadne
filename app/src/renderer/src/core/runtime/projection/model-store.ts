import type {
  PublicModelProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type ModelProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'models' }
>;

export class ModelStore extends ProjectionFeatureStore<PublicModelProjectionV3> {
  constructor() {
    super((model) => model.modelId);
  }
}
