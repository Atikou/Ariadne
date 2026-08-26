import { createHash } from 'node:crypto';

import type { ProjectionCommitV3 } from '@ariadne/protocol/public';

import type { RuntimePublicEventSink } from '../ingress/RuntimePublicEventSink.js';

/**
 * Composition bridge from silent Model projection commits to Runtime's
 * durable public event journal. Renderer treats the event only as a wake hint
 * and still rebuilds model state exclusively from the v3 Projection stream.
 */
export class ModelCatalogProjectionWakePublisher {
  public constructor(private readonly sink: RuntimePublicEventSink) {}

  public async publish(commit: ProjectionCommitV3): Promise<void> {
    if (
      commit.changes.length === 0
      || commit.changes.some((change) => change.feature !== 'models')
    ) {
      throw new Error('model_catalog_projection_wake_commit_invalid');
    }
    await this.sink.append({
      eventId: modelCatalogProjectionWakeEventId(commit.eventId),
      aggregateType: 'projection',
      aggregateId: commit.sourceId,
      aggregateVersion: commit.sourceCursor,
      causationId: commit.eventId,
      occurredAt: commit.occurredAt,
      event: {
        kind: 'projection.changed',
        feature: 'models'
      }
    });
  }
}

export function modelCatalogProjectionWakeEventId(
  projectionEventId: string
): string {
  if (projectionEventId.trim().length === 0) {
    throw new Error('model_catalog_projection_wake_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'ariadne.model-catalog.projection-wake',
      projectionEventId
    ]), 'utf8')
    .digest('hex');
  return `projection.changed:${digest}`;
}
