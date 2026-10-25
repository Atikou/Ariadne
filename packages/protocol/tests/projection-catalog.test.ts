import { expect, it } from 'vitest';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, publicProjectionCatalogBeginRequestSchema,
  publicProjectionCatalogPageSchema, publicProjectionCatalogDetailSchema,
  publicRunCatalogSummarySchema, publicDecisionCatalogSummarySchema,
  type PublicProjectionCatalogManifest } from '../src/public.js';

const NOW = '2032-01-01T00:00:00.000Z';
const manifest: PublicProjectionCatalogManifest = { pageContractVersion: '3.0', projectionContractVersion: '5.0',
  snapshotId: 'snapshot', streamId: 'stream', boundaryCursor: 0, boundaryDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
  scope: { kind: 'tasks' }, feature: 'runs', filter: 'active', capturedAt: NOW, expiresAt: '2032-01-01T00:05:00.000Z' };

it('keeps catalog feature/filter selection inside its declared domain', () => {
  expect(publicProjectionCatalogBeginRequestSchema.safeParse({ pageContractVersion: '3.0', scope: { kind: 'directory' }, feature: 'runs', filter: 'all' }).success).toBe(false);
  expect(publicProjectionCatalogBeginRequestSchema.safeParse({ pageContractVersion: '3.0', scope: { kind: 'tasks' }, feature: 'runs', filter: 'archived' }).success).toBe(false);
  expect(publicProjectionCatalogBeginRequestSchema.safeParse({ pageContractVersion: '3.0', scope: { kind: 'decisions' }, feature: 'decisions', filter: 'pending' }).success).toBe(true);
});

it('rejects bodies and action tokens from strict minimal summaries', () => {
  const run = { runId: 'run', version: 1, title: 'Run', label: 'Working', status: 'running', updatedAt: NOW,
    queuedInputCount: 0, claimedInputCount: 0, toolActivityCount: 0, interactionMessageCount: 0 };
  expect(publicRunCatalogSummarySchema.safeParse(run).success).toBe(true);
  expect(publicRunCatalogSummarySchema.safeParse({ ...run, inbox: [] }).success).toBe(false);
  expect(publicRunCatalogSummarySchema.safeParse({ ...run, interactionMessages: [] }).success).toBe(false);
  const decision = { decisionId: 'decision', runId: 'run', sessionId: 'session', version: 1, title: 'Question', kind: 'user_question', status: 'pending', requestedAt: NOW };
  expect(publicDecisionCatalogSummarySchema.safeParse(decision).success).toBe(true);
  expect(publicDecisionCatalogSummarySchema.safeParse({ ...decision, question: 'Private question' }).success).toBe(false);
  expect(publicDecisionCatalogSummarySchema.safeParse({ ...decision, actionToken: 'token' }).success).toBe(false);
});

it('rejects totals from another status domain, excluded filter statuses and inconsistent sums', () => {
  const page = { status: 'ok', manifest, pageIndex: 0, previousPageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
    pageDigest: PUBLIC_PROJECTION_GENESIS_DIGEST, totalRows: 0, statusCounts: {}, decisionKindCounts: {}, rows: [], hasMore: false };
  expect(publicProjectionCatalogPageSchema.safeParse(page).success).toBe(true);
  expect(publicProjectionCatalogPageSchema.safeParse({ ...page, statusCounts: { running: 1 } }).success).toBe(false);
  expect(publicProjectionCatalogPageSchema.safeParse({ ...page, totalRows: 1, statusCounts: { archived: 1 } }).success).toBe(false);
  expect(publicProjectionCatalogPageSchema.safeParse({ ...page, totalRows: 1, statusCounts: { completed: 1 } }).success).toBe(false);
});

it('rejects a Session detail crossing the manifest workspace', () => {
  expect(publicProjectionCatalogDetailSchema.safeParse({ status: 'ok', manifest: { ...manifest,
    scope: { kind: 'directory', workspaceId: 'workspace-a' }, feature: 'sessions', filter: 'all' },
    aggregateId: 'session', detailDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
    change: { feature: 'sessions', aggregateId: 'session', aggregateVersion: 1, operation: 'upsert', projectedAt: NOW,
      dto: { sessionId: 'session', workspaceId: 'workspace-b', version: 1, title: 'Session', pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } }
  }).success).toBe(false);
});
