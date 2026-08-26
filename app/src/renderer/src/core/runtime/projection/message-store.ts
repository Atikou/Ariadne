import type {
  PublicMessageProjectionV3,
  PublicProjectionChangeV3
} from '@ariadne/protocol/public';
import { ProjectionFeatureStore } from './projection-feature-store';

export type MessageProjectionChange = Extract<
  PublicProjectionChangeV3,
  { feature: 'messages' }
>;

export class MessageStore extends ProjectionFeatureStore<PublicMessageProjectionV3> {
  constructor() {
    super((message) => message.messageId);
  }
}
