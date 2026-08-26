import type {
  PublicProjectionChangeV3,
  PublicRunProjectionV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type RunProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'runs' }
>;

export class RunStore extends ProjectionFeatureStore<PublicRunProjectionV3> {
  constructor() {
    super((run) => run.runId);
  }
}
