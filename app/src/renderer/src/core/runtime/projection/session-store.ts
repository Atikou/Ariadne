import type {
  PublicProjectionChangeV3,
  PublicSessionProjectionV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type SessionProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'sessions' }
>;

export class SessionStore extends ProjectionFeatureStore<PublicSessionProjectionV3> {
  constructor() {
    super((session) => session.sessionId);
  }
}
