import { createHash } from 'node:crypto';

import type {
  ProjectionCommitV3,
  PublicProjectionFeatureV3
} from '@ariadne/protocol/public';

import type { RuntimePublicEventSink } from '../ingress/RuntimePublicEventSink.js';
import type { PublicProjectionCommitSink } from '../projection/PublicProjectionPorts.js';

/**
 * Completes the public Projection commit boundary with a non-authoritative
 * Runtime wake hint. The wrapped Projection remains the only source of truth;
 * a hint only tells connected Renderers to replay its durable tail.
 */
export class PublicProjectionWakeCommitSink
implements PublicProjectionCommitSink {
  private readonly wakePublisher: PublicProjectionWakePublisher;

  public constructor(
    private readonly projection: PublicProjectionCommitSink,
    wakeEvents: RuntimePublicEventSink
  ) {
    this.wakePublisher = new PublicProjectionWakePublisher(wakeEvents);
  }

  public async append(commit: ProjectionCommitV3): Promise<unknown> {
    const result = await this.projection.append(commit);
    await this.wakePublisher.publish(commit);
    return result;
  }
}

/** Emits stable per-feature hints after an already durable Projection commit. */
export class PublicProjectionWakePublisher {
  public constructor(private readonly wakeEvents: RuntimePublicEventSink) {}

  public async publish(commit: ProjectionCommitV3): Promise<void> {
    const features = uniqueFeatures(commit);
    await Promise.all(features.map(async (feature) => {
      await this.wakeEvents.append({
        eventId: projectionWakeEventId(commit.eventId, feature),
        aggregateType: 'projection',
        aggregateId: projectionWakeAggregateId(commit.sourceId, feature),
        aggregateVersion: commit.sourceCursor,
        causationId: commit.eventId,
        occurredAt: commit.occurredAt,
        event: {
          kind: 'projection.changed',
          feature
        }
      });
    }));
  }
}

export function projectionWakeEventId(
  projectionEventId: string,
  feature: PublicProjectionFeatureV3
): string {
  return hashedWakeIdentity('projection.changed', [projectionEventId, feature]);
}

export function projectionWakeAggregateId(
  sourceId: string,
  feature: PublicProjectionFeatureV3
): string {
  return hashedWakeIdentity('projection', [sourceId, feature]);
}

function uniqueFeatures(commit: ProjectionCommitV3): readonly PublicProjectionFeatureV3[] {
  return [...new Set(commit.changes.map((change) => change.feature))];
}

function hashedWakeIdentity(prefix: string, parts: readonly string[]): string {
  if (parts.some((part) => part.trim().length === 0)) {
    throw new Error('public_projection_wake_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(['ariadne.public-projection.wake', ...parts]), 'utf8')
    .digest('hex');
  return `${prefix}:${digest}`;
}
