import { describe, expect, it } from 'vitest';
import { taskCenterFilterSchema, taskCenterNavigationSchema, taskCenterPageSchema,
  taskSourceMetadataSchema, taskReferenceKey } from '../src/public/task-center.js';

const time = '2026-10-06T00:00:00.000Z';
const metadata = { reference: { source: 'workflow', sourceId: 'shared-id' }, workspaceId: 'workspace-a', sessionId: 'session-a',
  title: '工作流 #shared-id', sourceStatus: 'running', state: 'running', version: 3, attempts: null,
  updatedAt: time, dueAt: null, relations: [], relationTotal: 0, runReferences: [], runReferenceTotal: 0 };
const filter = { reference: null, workspaceId: null, sessionId: null, includeArchived: false,
  sources: ['run', 'goal', 'workflow', 'schedule', 'occurrence'], states: [], updatedFrom: null, updatedThrough: null };
const page = { kind: 'tasks.query_result', contractVersion: '1.0', snapshotId: 'snapshot-a', capturedAt: time,
  expiresAt: '2026-10-06T00:05:00.000Z', consistency: 'eventual', filter, complete: true,
  watermarks: ['projection', 'productivity', 'conversation'].map(source => ({ source, status: 'ready', revision: 4, capturedAt: time, diagnosticCode: null })),
  indexedTotal: 1, rows: [{ metadata, archived: false, decisions: [], result: 'pending' }], pageCursor: 'cursor-a', nextCursor: null };

describe('authorized task center read contract', () => {
  it('separates equal source IDs without inventing task authority', () => {
    expect(taskReferenceKey({ source: 'goal', sourceId: 'shared-id' })).not.toEqual(taskReferenceKey({ source: 'workflow', sourceId: 'shared-id' }));
    expect(taskSourceMetadataSchema.parse(metadata)).toEqual(metadata);
  });
  it('rejects private inputs, results and decision tokens in list records', () => {
    for (const key of ['prompt', 'criteria', 'resultBody', 'context', 'actionToken'])
      expect(taskSourceMetadataSchema.safeParse({ ...metadata, [key]: 'protected input' }).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...page, rows: [{ ...page.rows[0], decisions: [{ runId: 'run-a', decisionId: 'decision-a',
      workspaceId: 'workspace-a', sessionId: 'session-a', kind: 'permission', version: 1, actionToken: 'protected' }] }] }).success).toBe(false);
  });
  it('requires an explicit Workspace for session filtering and rejects ambiguous selections', () => {
    expect(taskCenterFilterSchema.parse(filter)).toEqual(filter);
    expect(taskCenterFilterSchema.safeParse({ ...filter, sessionId: 'session-a' }).success).toBe(false);
    expect(taskCenterFilterSchema.safeParse({ ...filter, sources: ['run', 'run'] }).success).toBe(false);
    expect(taskCenterFilterSchema.safeParse({ ...filter, updatedFrom: '2026-10-07T00:00:00.000Z', updatedThrough: time }).success).toBe(false);
  });
  it('retains occurrence attempts independently of domain versions', () => {
    expect(taskSourceMetadataSchema.safeParse({ ...metadata, reference: { source: 'occurrence', sourceId: 'occurrence-a' }, version: null, attempts: 0 }).success).toBe(true);
    expect(taskSourceMetadataSchema.safeParse({ ...metadata, reference: { source: 'occurrence', sourceId: 'occurrence-a' }, attempts: 0 }).success).toBe(false);
    const navigation = { kind: 'tasks.navigate', contractVersion: '1.0', reference: metadata.reference,
      workspaceId: 'workspace-a', sessionId: 'session-a', expectedVersion: 3, expectedAttempts: null,
      expectedSourceStatus: 'running', decisionId: null, expectedDecisionVersion: null, destination: 'recovery' };
    expect(taskCenterNavigationSchema.parse(navigation)).toEqual(navigation);
    expect(taskCenterNavigationSchema.safeParse({ ...navigation, expectedVersion: null }).success).toBe(false);
  });
  it('binds decision navigation to its exact revision and returned rows to the filter', () => {
    const navigation = { kind: 'tasks.navigate', contractVersion: '1.0', reference: metadata.reference,
      workspaceId: 'workspace-a', sessionId: 'session-a', expectedVersion: 3, expectedAttempts: null,
      expectedSourceStatus: 'running', decisionId: 'decision-a', expectedDecisionVersion: 2, destination: 'decision' };
    expect(taskCenterNavigationSchema.parse(navigation)).toEqual(navigation);
    expect(taskCenterNavigationSchema.safeParse({ ...navigation, expectedDecisionVersion: null }).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...page, filter: { ...filter, workspaceId: 'workspace-b' } }).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...page, rows: [{ ...page.rows[0], archived: true }] }).success).toBe(false);
  });
  it('labels incomplete and cross-database coverage honestly', () => {
    expect(taskCenterPageSchema.parse(page)).toEqual(page);
    const partial = { ...page, watermarks: page.watermarks.map(item => item.source === 'productivity' ? { ...item, status: 'building' } : item) };
    expect(taskCenterPageSchema.safeParse(partial).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...partial, complete: false }).success).toBe(true);
    expect(taskCenterPageSchema.safeParse({ ...page, consistency: 'atomic' }).success).toBe(false);
  });
  it('rejects duplicate tasks, overfull pages and expired lifetimes', () => {
    expect(taskCenterPageSchema.safeParse({ ...page, indexedTotal: 2, rows: [page.rows[0], page.rows[0]] }).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...page, indexedTotal: 129, rows: Array.from({ length: 129 }, (_, index) => ({ ...page.rows[0],
      metadata: { ...metadata, reference: { source: 'workflow', sourceId: 'workflow-' + index } } })) }).success).toBe(false);
    expect(taskCenterPageSchema.safeParse({ ...page, expiresAt: time }).success).toBe(false);
  });
});
