import type {
  PublicDecisionProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type DecisionProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'decisions' }
>;

export class DecisionStore extends ProjectionFeatureStore<PublicDecisionProjectionV3> {
  constructor() {
    super((decision) => decision.decisionId);
  }
}
