import { describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ProjectionCommit
} from '@ariadne/protocol/public';

import {
  PublicProjectionWakeCommitSink,
  projectionWakeAggregateId,
  projectionWakeEventId
} from '../src/composition/PublicProjectionWakeCommitSink.js';
import type { RuntimePublicEventAppend } from '../src/ingress/RuntimePublicEventSink.js';
import { PublicRunDocumentWakeCommitSink } from '../src/composition/PublicRunDocumentWakeCommitSink.js';
import { RunDocumentPlan } from '../src/projection/RunDocumentPlan.js';
import { assertPublicRunDocumentCommit } from '@ariadne/protocol/public';

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
  it('emits document hints after the awaited final outcome and preserves identities across a failed-hint retry', async () => {
    const at = '2030-01-01T00:00:00.000Z', plan = new RunDocumentPlan({
      summary: { runId: 'run-test', sessionId: 'session-test', version: 1, title: '模拟文档', label: '模拟文档',
        status: 'running', updatedAt: at, toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 0 },
      toolActivities: [], inbox: [], interactionMessages: [] });
    const commit = assertPublicRunDocumentCommit({ contractVersion: '6.0', eventId: 'document-test', sourceId: 'document-source', sourceCursor: 1,
      occurredAt: at, changes: [{ feature: 'runs', operation: 'upsert', aggregateId: 'run-test', aggregateVersion: 1, projectedAt: at, dto: plan.header }] });
    let release!: () => void, failHint = true;
    const wait = new Promise<void>(done => { release = done; }), hints: RuntimePublicEventAppend[] = [], order: string[] = [];
    const sink = new PublicRunDocumentWakeCommitSink({ appendRunDocument: async (value, receivedPlan) => {
      expect(value).toBe(commit); expect(receivedPlan).toBe(plan); await wait; order.push('committed'); return 'original-C';
    } }, { append: async hint => { order.push('hint'); hints.push(hint); if (failHint) throw new Error('hint_failed'); } });
    const failed = expect(sink.appendRunDocument(commit, plan)).rejects.toThrow('hint_failed');
    await Promise.resolve(); expect(hints).toEqual([]); release(); await failed;
    failHint = false; await expect(sink.appendRunDocument(commit, plan)).resolves.toBe('original-C');
    expect(order).toEqual(['committed', 'hint', 'committed', 'hint']); expect(hints[0]).toEqual(hints[1]);
    const append = vi.fn(async () => undefined), rejected = new PublicRunDocumentWakeCommitSink({
      appendRunDocument: async () => { throw new Error('document_not_committed'); }
    }, { append });
    await expect(rejected.appendRunDocument(commit, plan)).rejects.toThrow('document_not_committed'); expect(append).not.toHaveBeenCalled();
  });
});

function projectionCommit(): ProjectionCommit {
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
  commit: ProjectionCommit,
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
