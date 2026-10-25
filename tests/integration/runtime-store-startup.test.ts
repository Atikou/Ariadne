import { expect, it, vi } from 'vitest';
import { ProjectionRuntimeHarness, deferred } from './support/projection-runtime-harness';
import { NOW, run, session, upsertChange } from '../../app/tests/projection-v3-fixture';
import { runtimeEnvelope } from '../../app/tests/runtime-event-fixture';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries';
import type { RuntimeStatus } from '@ariadne/protocol/public';

it('presents append-only chunks on the next frame without additional Projection reads', async () => {
  const fixture = new ProjectionRuntimeHarness();
  await fixture.append([upsertChange('sessions', session('session-a'), 'session-a')]);
  await fixture.renderer.initialize(); await fixture.renderer.sessions.select('session-a');
  const before = fixture.commands.length;
  for (let sequence = 1; sequence <= 2; sequence++) {
    fixture.event(runtimeEnvelope({ contractVersion: '1.0', kind: 'inference.chunk.observed', sessionId: 'session-a',
      runId: 'run-live', turnId: 'turn-live', attemptId: 'attempt-live', sequence, channel: 'token', text: String(sequence), observedAt: NOW }, sequence));
    await vi.waitFor(() => expect(fixture.renderer.getSnapshot().messages[0]?.content).toBe(sequence === 1 ? '1' : '12'));
  }
  expect(fixture.commands).toHaveLength(before);
});

it('converges on Supervisor ready after an older startup status resolves', async () => {
  const fixture = new ProjectionRuntimeHarness(), status = deferred<RuntimeStatus>(); fixture.queryStatus = () => status.promise;
  const initializing = fixture.renderer.initialize(); fixture.emitStatus(fixture.status);
  status.resolve({ availability: 'starting', capabilities: [], observedAt: '2026-07-30T23:59:59.000Z' });
  await initializing;
  expect(fixture.renderer.getSnapshot()).toMatchObject({ initialized: true, status: { availability: 'ready' }, projectionStreamId: fixture.backend.streamId, lastError: null });
});

it('subscribes before bounded cold capture and scans each range from its own exact Cursor and Digest', async () => {
  const fixture = new ProjectionRuntimeHarness(); await fixture.append([upsertChange('sessions', session('session-a'), 'session-a')]);
  await fixture.renderer.initialize();
  expect(fixture.order[0]).toBe('subscribe'); expect(fixture.order[1]).toBe('projection.catalog.begin');
  const manifest = fixture.renderer.getSnapshot().projectionWindows.sessions!.page.manifest;
  await fixture.renderer.refresh();
  const scan = fixture.commands.find(command => command.kind === 'projection.catalog.read');
  expect(scan).toMatchObject({ kind: 'projection.catalog.read', request: { afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest,
    manifest: { snapshotId: manifest.snapshotId } } });
  expect(fixture.commands.some(command => ['projection.snapshot.get', 'projection.commits.read', 'events.replay'].includes(command.kind))).toBe(false);
});

it('polls active task summaries even when no wake hint arrives and the Run body is outside the selected Session', async () => {
  const fixture = new ProjectionRuntimeHarness(); const active = run('run-active');
  await fixture.append([upsertChange('sessions', session('session-a'), 'session-a'), upsertChange('runs', active, active.runId)]);
  await fixture.renderer.initialize(); expect(fixture.renderer.getSnapshot().runs).toEqual([]);
  expect(fixture.renderer.getSnapshot().runSummaries[0]?.status).toBe('running');
  await fixture.append([upsertChange('runs', { ...active, version: 2, status: 'completed' }, active.runId)]);
  await vi.waitFor(() => expect(fixture.renderer.getSnapshot().runSummaries[0]?.status).toBe('completed'), { timeout: 2_000 });
});

it('treats an event during fixed-boundary capture as a wake hint and converges without event-derived entities', async () => {
  const fixture = new ProjectionRuntimeHarness(), gate = deferred(), received = deferred(); let delay = true;
  fixture.request = async (command, read) => {
    const result = await read();
    if (command.kind === 'projection.catalog.begin' && delay) { delay = false; received.resolve(); await gate.promise; }
    return result;
  };
  const initializing = fixture.renderer.initialize(); await received.promise;
  await fixture.append([upsertChange('sessions', session('session-race'), 'session-race')]);
  fixture.event(runtimeEnvelope({ kind: 'projection.changed', feature: 'sessions' }, 1)); gate.resolve(); await initializing;
  expect(fixture.renderer.getSnapshot()).toMatchObject({ sessions: [{ sessionId: 'session-race' }], trace: [], lastError: null });
});

it.each(['snapshot_expired', 'cursor_gap', 'history_mismatch'] as const)('recaptures read ranges after %s without a global fallback', async reason => {
  const fixture = new ProjectionRuntimeHarness(); await fixture.renderer.initialize();
  await fixture.append([upsertChange('sessions', session(`after-${reason}`), `after-${reason}`)]);
  let reset = true;
  fixture.request = async (command, read) => {
    if (command.kind === 'projection.catalog.read' && reset) { reset = false; return { kind: 'projection.catalog.batch',
      batch: { status: 'reset_required', streamId: fixture.backend.streamId, reason } }; }
    return read();
  };
  await fixture.renderer.refresh();
  expect(fixture.renderer.getSnapshot()).toMatchObject({ sessions: [{ sessionId: `after-${reason}` }], projectionIntegrityError: null, lastError: null });
});

it('fails closed on a contract mismatch instead of silently retrying an incompatible contract', async () => {
  const fixture = new ProjectionRuntimeHarness(); await fixture.renderer.initialize(); let failures = 0;
  fixture.request = async (command, read) => {
    if (command.kind === 'projection.catalog.read') { failures++; return { kind: 'projection.catalog.batch',
      batch: { status: 'reset_required', streamId: fixture.backend.streamId, reason: 'contract_mismatch' } }; }
    return read();
  };
  await fixture.renderer.refresh();
  expect(failures).toBe(1); expect(fixture.renderer.getSnapshot().lastError).toContain('contract_mismatch');
});

it('recaptures a rotated stream without mixing entities from separate Runtime generations', async () => {
  const first = new ProjectionRuntimeHarness(), second = new ProjectionRuntimeHarness();
  await first.append([upsertChange('sessions', session('old-session'), 'old-session')]);
  await second.append([upsertChange('sessions', session('new-session'), 'new-session')]);
  await first.renderer.initialize();
  first.request = command => readAgentProjectionQuery(second.backend, command);
  await first.renderer.refresh();
  expect(first.renderer.getSnapshot()).toMatchObject({ projectionStreamId: second.backend.streamId, sessions: [{ sessionId: 'new-session' }], lastError: null });
});

it('clears read state on disconnect and captures bounded ranges after a Runtime restart', async () => {
  const first = new ProjectionRuntimeHarness(), second = new ProjectionRuntimeHarness();
  await first.append([upsertChange('sessions', session('before-restart'), 'before-restart')]);
  await second.append([upsertChange('sessions', session('after-restart'), 'after-restart')]);
  await first.renderer.initialize();
  first.emitStatus({ ...first.status, availability: 'restarting', observedAt: '2026-07-31T00:00:01.000Z' });
  expect(first.renderer.getSnapshot()).toMatchObject({ projectionStreamId: null, sessions: [] });
  first.request = command => readAgentProjectionQuery(second.backend, command);
  first.emitStatus({ ...first.status, availability: 'ready', observedAt: '2026-07-31T00:00:02.000Z' });
  await vi.waitFor(() => expect(first.renderer.getSnapshot()).toMatchObject({ projectionStreamId: second.backend.streamId, sessions: [{ sessionId: 'after-restart' }], lastError: null }));
});

it('discards a late manifest across dispose and reinitialize while keeping one active subscription', async () => {
  const fixture = new ProjectionRuntimeHarness(), gate = deferred(), received = deferred(); let delay = true;
  fixture.request = async (command, read) => {
    const result = await read();
    if (command.kind === 'projection.catalog.begin' && delay) { delay = false; received.resolve(); await gate.promise; }
    return result;
  };
  const older = fixture.renderer.initialize(); await received.promise; fixture.renderer.dispose();
  await fixture.append([upsertChange('sessions', session('new-session'), 'new-session')]);
  await fixture.renderer.initialize(); const trusted = fixture.renderer.getSnapshot(); gate.resolve(); await older;
  expect(fixture.activeSubscriptions).toBe(1); expect(fixture.renderer.getSnapshot()).toBe(trusted);
  expect(trusted.sessions).toMatchObject([{ sessionId: 'new-session' }]);
});

it('latches a malformed catalog page and preserves the failure across refresh and detail navigation', async () => {
  const fixture = new ProjectionRuntimeHarness();
  fixture.request = async (_command, read) => { const result = await read(); return result.kind === 'projection.catalog.page_result' && result.page.status === 'ok'
    ? { ...result, page: { ...result.page, pageDigest: `sha256:${'f'.repeat(64)}` } } : result; };
  await fixture.renderer.initialize(); const first = fixture.renderer.getSnapshot().projectionIntegrityError;
  expect(first).toMatch(/^projection_integrity_error:/u); await fixture.renderer.refresh();
  expect(fixture.renderer.getSnapshot()).toMatchObject({ projectionIntegrityError: first, lastError: first, sessions: [] });
  await expect(fixture.renderer.openRunDetail('missing')).rejects.toThrow(first!);
});
