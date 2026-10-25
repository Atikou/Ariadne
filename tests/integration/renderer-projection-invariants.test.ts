import { auditStoredProjectionState as auditDocumentMigration } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore';
import { appendProjectionLedgerCommit as appendDocumentLedger } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore';
import { expect, it } from 'vitest';
import { ProjectionRuntimeHarness, deferred } from './support/projection-runtime-harness';
import { NOW, model, run, session, upsertChange } from '../../app/tests/projection-v3-fixture';
import { DatabaseSync } from 'node:sqlite';
import { RunDocumentPlan } from '../../runtime/src/projection/RunDocumentPlan';
import { SqliteRunDocumentPublication } from '../../runtime/src/adapters/persistence/SqliteRunDocumentPublication';
import { upgradeRunDocumentSchema } from '../../runtime/src/adapters/persistence/RunDocumentDbSchema';

it('preserves unrelated feature identities while independently advancing a Session and keeping explicit Run states', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append([upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('models', model('model-a'), 'model-a'),
    upsertChange('runs', run('run-a', 'waiting_children'), 'run-a'), upsertChange('runs', run('run-b', 'cancelling'), 'run-b')]);
  await fixture.renderer.initialize(); await fixture.renderer.sessions.select('session-a');
  const before = fixture.renderer.getSnapshot();
  await fixture.append([upsertChange('sessions', { ...session('session-a', 2), title: 'Updated session' }, 'session-a')]);
  await fixture.renderer.refresh();
  const after = fixture.renderer.getSnapshot();
  expect(after.sessions[0]?.title).toBe('Updated session');
  expect(after.models).toBe(before.models); expect(after.runs).toBe(before.runs);
  expect(after.runSummaries.map(item => item.status).sort()).toEqual(['cancelling', 'waiting_children']);
  const stable = fixture.renderer.getSnapshot(); await fixture.renderer.refresh();
  expect(fixture.renderer.getSnapshot().sessions).toBe(stable.sessions);
});

it('reads a restored aggregate after a persisted tombstone without resurrecting its older body', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append([upsertChange('models', model('model-a'), 'model-a')]); await fixture.renderer.initialize();
  await fixture.append([{ feature: 'models', operation: 'delete', aggregateId: 'model-a', aggregateVersion: 2, projectedAt: NOW, dto: null }]);
  await fixture.renderer.refresh(); expect(fixture.renderer.getSnapshot().models).toEqual([]);
  await fixture.append([upsertChange('models', model('model-a', 3), 'model-a')]); await fixture.renderer.refresh();
  expect(fixture.renderer.getSnapshot().models).toMatchObject([{ id: 'model-a' }]);
  expect(fixture.renderer.getSnapshot().projectionIntegrityError).toBeNull();
});

it('keeps skipped aggregate versions at the durable owner and preserves the trusted Renderer body', async () => {
  const fixture = new ProjectionRuntimeHarness(); await fixture.append([upsertChange('sessions', session('session-a'), 'session-a')]);
  await fixture.renderer.initialize(); const trusted = fixture.renderer.getSnapshot().sessions;
  await expect(fixture.append([upsertChange('sessions', session('session-a', 3), 'session-a')])).rejects.toThrow();
  await fixture.renderer.refresh(); expect(fixture.renderer.getSnapshot().sessions).toBe(trusted);
});

it('distinguishes unread model configuration from a verified empty range during startup and recovery', async () => {
  const fixture = new ProjectionRuntimeHarness(), received = deferred(), gate = deferred(); let delay = true;
  fixture.request = async (command, read) => {
    if (command.kind === 'projection.features.window' && command.request.window.feature === 'models' && delay) {
      delay = false; received.resolve(); await gate.promise;
    }
    return read();
  };
  const initializing = fixture.renderer.initialize(); await received.promise;
  expect(fixture.renderer.models.view.getSnapshot()).toEqual({ models: [], modelsReadReady: false });
  gate.resolve(); await initializing;
  expect(fixture.renderer.models.view.getSnapshot()).toEqual({ models: [], modelsReadReady: true });
  fixture.emitStatus({ ...fixture.status, availability: 'restarting', observedAt: '2026-07-31T00:00:01.000Z' });
  expect(fixture.renderer.models.view.getSnapshot()).toEqual({ models: [], modelsReadReady: false });
});

it('refreshes the production Renderer model range across a large document commit without a complete scoped read or reset', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append([upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('models', model('model-a'), 'model-a')]);
  await fixture.renderer.initialize(); const before = fixture.renderer.getSnapshot(); expect(before.selectedSessionId).toBeNull();
  const database = (fixture.backend as unknown as { database: DatabaseSync }).database; upgradeRunDocumentSchema(database, auditDocumentMigration);
  const plan = new RunDocumentPlan({ summary: { runId: 'document-run', sessionId: 'session-a', version: 1, title: '模拟文档', label: '模拟文档',
    status: 'completed', updatedAt: NOW, toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 1 }, toolActivities: [], inbox: [],
    interactionMessages: [{ messageId: 'document-message', sessionId: 'session-a', runId: 'document-run', version: 1, role: 'assistant',
      content: 'LARGE_RENDERER_FIXTURE🙂'.repeat(40_000), status: 'completed', createdAt: NOW, updatedAt: NOW }] });
  await new SqliteRunDocumentPublication(database, fixture.backend.streamId, appendDocumentLedger).publish({ contractVersion: '6.0', sourceId: 'document-fixture', sourceCursor: 1,
    eventId: 'document-fixture-1', occurredAt: NOW, changes: [{ feature: 'runs', aggregateId: 'document-run', aggregateVersion: 1,
      operation: 'upsert', projectedAt: NOW, dto: plan.header }] }, plan);
  await fixture.renderer.refresh(); expect(fixture.renderer.getSnapshot().models).toBe(before.models);
  expect(fixture.renderer.getSnapshot().runSummaries).toMatchObject([{ runId: 'document-run' }]);
  await fixture.append([upsertChange('models', { ...model('model-a', 2), label: 'Updated model' }, 'model-a')]);
  await fixture.renderer.refresh(); expect(fixture.renderer.getSnapshot().models).toMatchObject([{ id: 'model-a', label: 'Updated model' }]);
  expect(fixture.renderer.getSnapshot().projectionIntegrityError).toBeNull(); expect(fixture.renderer.models.view.getSnapshot().modelsReadReady).toBe(true);
  expect(fixture.commands.some(command => command.kind === 'projection.features.receipts')).toBe(true);
  expect(fixture.commands.some(command => command.kind === 'projection.scope.read' || command.kind === 'projection.run_document.chunk')).toBe(false);
});
