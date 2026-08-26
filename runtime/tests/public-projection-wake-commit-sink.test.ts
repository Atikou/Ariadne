import { describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ProjectionCommitV3
} from '@ariadne/protocol/public';

import {
  PublicProjectionWakeCommitSink,
  projectionWakeAggregateId,
  projectionWakeEventId
} from '../src/composition/PublicProjectionWakeCommitSink.js';
import type { RuntimePublicEventAppend } from '../src/ingress/RuntimePublicEventSink.js';

describe('PublicProjectionWakeCommitSink', () => {
  it('emits stable per-feature wake hints only after the authoritative commit succeeds', async () => {
    const order: string[] = [];
    const wakes: RuntimePublicEventAppend[] = [];
    const commit = projectionCommit();
    const sink = new PublicProjectionWakeCommitSink(
      {
        append: async (value) => {
          expect(value).toBe(commit);
          order.push('projection');
          return 'committed';
        }
      },
      {
        append: async (event) => {
          order.push(`wake:${event.event.kind === 'projection.changed'
            ? event.event.feature
            : 'invalid'}`);
          wakes.push(event);
        }
      }
    );

    await expect(sink.append(commit)).resolves.toBe('committed');

    expect(order[0]).toBe('projection');
    expect(new Set(order.slice(1))).toEqual(new Set(['wake:runs', 'wake:decisions']));
    expect(wakes).toHaveLength(2);
    expect(wakes).toEqual(expect.arrayContaining([
      wakeFor(commit, 'runs'),
      wakeFor(commit, 'decisions')
    ]));
  });

  it('does not claim a wake when the Projection commit failed', async () => {
    const appendWake = vi.fn(async () => undefined);
    const sink = new PublicProjectionWakeCommitSink(
      { append: async () => { throw new Error('projection_commit_failed'); } },
      { append: appendWake }
    );

    await expect(sink.append(projectionCommit())).rejects.toThrow(
      'projection_commit_failed'
    );
    expect(appendWake).not.toHaveBeenCalled();
  });
});

function projectionCommit(): ProjectionCommitV3 {
  const projectedAt = '2030-01-01T00:00:00.000Z';
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: 'agent-run.changed:test:2',
    sourceId: 'agent-run:test',
    sourceCursor: 2,
    occurredAt: projectedAt,
    changes: [
      {
        feature: 'runs',
        operation: 'delete',
        aggregateId: 'run-test',
        aggregateVersion: 2,
        projectedAt,
        dto: null
      },
      {
        feature: 'decisions',
        operation: 'delete',
        aggregateId: 'decision-test',
        aggregateVersion: 1,
        projectedAt,
        dto: null
      }
    ]
  };
}

function wakeFor(
  commit: ProjectionCommitV3,
  feature: 'runs' | 'decisions'
): RuntimePublicEventAppend {
  return {
    eventId: projectionWakeEventId(commit.eventId, feature),
    aggregateType: 'projection',
    aggregateId: projectionWakeAggregateId(commit.sourceId, feature),
    aggregateVersion: commit.sourceCursor,
    causationId: commit.eventId,
    occurredAt: commit.occurredAt,
    event: { kind: 'projection.changed', feature }
  };
}
