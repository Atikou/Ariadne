import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, type ProjectionCommit,
  type PublicDecisionProjection, type PublicProjectionChange, type RuntimeCommand } from '@ariadne/protocol/public';
import { DecisionNotificationSource } from '../../app/src/main/services/decision-notification-source.js';
import { ProjectionRuntimeClient } from '../../app/src/renderer/src/core/runtime/projection/projection-runtime-client.js';
import { ProjectionScopeStaging } from '../../app/src/renderer/src/core/runtime/projection/projection-scope-staging.js';
import { SqlitePublicProjectionStore } from '../../runtime/src/adapters/persistence/SqlitePublicProjectionStore.js';
import { readAgentProjectionQuery } from '../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries.js';

const roots: string[] = [];
const stores: SqlitePublicProjectionStore[] = [];
const NOW = '2026-10-05T00:00:00.000Z';
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Public Projection consumers with production scoped queries', () => {
  it('reads minimal catalogs, explicit details and continuous catalog scans through the Renderer client', async () => {
    const store = createStore();
    await store.append(commit(1, [decisionChange(0, 'user_question')]));
    const client = new ProjectionRuntimeClient({
      request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
      getStatus: async () => { throw new Error('unused_status'); }, onEvent: () => () => undefined, onStatus: () => () => undefined
    });
    const manifest = await client.beginCatalog({ scope: { kind: 'decisions' }, feature: 'decisions', filter: 'pending' });
    const page = await client.readCatalogPage(manifest);
    expect(page).toMatchObject({ status: 'ok', totalRows: 1, decisionKindCounts: { user_question: 1 }, rows: [{ dto: { decisionId: id(0), title: 'User question' } }] });
    expect(JSON.stringify(page)).not.toContain('decision-action');
    expect(JSON.stringify(page)).not.toContain('Question text');
    expect(await client.readCatalogDetail(manifest, id(0)))
      .toMatchObject({ status: 'ok', change: { dto: { presentation: { question: 'Question text must not enter the notification DTO' } } } });
    const original = decisionChange(0, 'user_question');
    if (original.feature !== 'decisions' || original.dto === null) throw new Error('decision_fixture_missing');
    const { action: _action, ...dto } = original.dto;
    await store.append(commit(2, [{ ...original, aggregateVersion: 2, dto: { ...dto, version: 2, status: 'approved', resolvedAt: NOW } }]));
    const request = { manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 };
    expect(await client.readCatalogCommits(request)).toMatchObject({ status: 'ok', entries: [{ changes: [{ operation: 'remove', row: null }] }] });
  });

  it('rejects catalog replies for another owner or with a changed page, detail or scan digest', async () => {
    const store = createStore();
    await store.append(commit(1, [decisionChange(0)]));
    let mode: 'valid' | 'selection' | 'page' | 'detail' | 'scan' = 'valid';
    const client = new ProjectionRuntimeClient({ request: async command => {
      const result = await readAgentProjectionQuery(store, command);
      if (mode === 'selection' && result.kind === 'projection.catalog.manifest' && !('status' in result.manifest)) {
        return { ok: true, value: { ...result, manifest: { ...result.manifest, filter: 'all' } } };
      }
      if (mode === 'page' && result.kind === 'projection.catalog.page_result' && result.page.status === 'ok') {
        return { ok: true, value: { ...result, page: { ...result.page, pageDigest: `sha256:${'0'.repeat(64)}` } } };
      }
      if (mode === 'detail' && result.kind === 'projection.catalog.detail_result' && result.detail.status === 'ok') {
        return { ok: true, value: { ...result, detail: { ...result.detail, aggregateId: 'other-decision' } } };
      }
      if (mode === 'scan' && result.kind === 'projection.catalog.batch' && result.batch.status === 'ok') {
        return { ok: true, value: { ...result, batch: { ...result.batch, batchDigest: `sha256:${'0'.repeat(64)}` } } };
      }
      return { ok: true, value: result };
    }, getStatus: async () => { throw new Error('unused_status'); }, onEvent: () => () => undefined, onStatus: () => () => undefined });
    const selection = { scope: { kind: 'decisions' as const }, feature: 'decisions' as const, filter: 'pending' as const };
    const manifest = await client.beginCatalog(selection);
    mode = 'selection'; await expect(client.beginCatalog(selection)).rejects.toThrow('catalog_selection_mismatch');
    mode = 'page'; await expect(client.readCatalogPage(manifest)).rejects.toThrow('catalog_page_digest_mismatch');
    mode = 'detail'; await expect(client.readCatalogDetail(manifest, id(0))).rejects.toThrow('projection_protocol_integrity_error');
    mode = 'scan'; await expect(client.readCatalogCommits({ manifest, afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 }))
      .rejects.toThrow('catalog_batch_digest_mismatch');
  });

  it('keeps a multi-page metadata staging incomplete after a reset and enforces its own allocation bound', async () => {
    const store = createStore();
    await store.append(commit(1, Array.from({ length: 130 }, (_, index): PublicProjectionChange => ({
      feature: 'sessions', operation: 'upsert', aggregateId: `session-${String(index).padStart(3, '0')}`,
      aggregateVersion: 1, projectedAt: NOW, dto: { sessionId: `session-${String(index).padStart(3, '0')}`,
        workspaceId: 'workspace-1', version: 1, title: `Session ${index}`, pinned: false, status: 'active',
        createdAt: NOW, updatedAt: NOW }
    }))));
    const client = new ProjectionRuntimeClient({
      request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
      getStatus: async () => { throw new Error('status_not_used'); },
      onEvent: () => () => undefined, onStatus: () => () => undefined
    });
    const manifest = await client.beginViewSnapshot({ kind: 'directory' }, ['sessions']);
    const first = await client.readViewPage(manifest);
    if (first.status !== 'ok') throw new Error('metadata_page_unavailable');
    const staging = new ProjectionScopeStaging(manifest);
    await staging.addPage(first);
    expect(() => staging.finish()).toThrow('staging_incomplete');
    await expect(staging.addPage({ status: 'reset_required', streamId: manifest.streamId, reason: 'snapshot_expired' }))
      .rejects.toThrow('projection_snapshot_reset_required:snapshot_expired');
    expect(() => staging.finish()).toThrow('staging_incomplete');
    const bounded = new ProjectionScopeStaging(manifest, 10);
    await expect(bounded.addPage(first)).rejects.toThrow('staging_capacity_exceeded');
    expect(() => bounded.finish()).toThrow('staging_incomplete');
    await staging.addPage(await client.readViewPage(manifest, first.nextPageCursor));
    expect(staging.finish().changes).toHaveLength(130);
  });

  it('loads selected Session metadata and an anchored Message window through the Renderer public client', async () => {
    const store = createStore();
    await store.append(commit(1, [{ feature: 'sessions', operation: 'upsert', aggregateId: 'session-1',
      aggregateVersion: 1, projectedAt: NOW, dto: { sessionId: 'session-1', workspaceId: 'workspace-1', version: 1,
        title: 'Session One', pinned: false, status: 'active', createdAt: NOW, updatedAt: NOW } },
      ...Array.from({ length: 100 }, (_, index): PublicProjectionChange => ({
        feature: 'messages', operation: 'upsert', aggregateId: `message-${String(index).padStart(3, '0')}`,
        aggregateVersion: 1, projectedAt: NOW, dto: { messageId: `message-${String(index).padStart(3, '0')}`,
          sessionId: 'session-1', version: 1, role: 'assistant', content: `Message ${index}`, status: 'completed',
          createdAt: NOW, updatedAt: NOW }
      }))]));
    const client = new ProjectionRuntimeClient({
      request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
      getStatus: async () => { throw new Error('status_not_used'); },
      onEvent: () => () => undefined, onStatus: () => () => undefined
    });
    const manifest = await client.beginViewSnapshot({ kind: 'session', workspaceId: 'workspace-1', sessionId: 'session-1' },
      ['decisions', 'inference_streams', 'runs']);
    const staging = new ProjectionScopeStaging(manifest);
    expect(() => staging.finish()).toThrow('staging_incomplete');
    await staging.addPage(await client.readViewPage(manifest));
    expect(() => staging.finish()).toThrow('staging_incomplete');
    await expect(staging.addWindow({ kind: 'around', anchorMessageId: 'message-missing', limit: 5 },
      { status: 'anchor_unavailable', snapshotId: 'another-generation' }))
      .rejects.toThrow('projection_protocol_integrity_error:public_projection_message_window_request_mismatch');
    expect(() => staging.finish()).toThrow('staging_incomplete');
    const latest = await client.readMessageWindow(manifest, { kind: 'latest', limit: 10 });
    expect(latest).toMatchObject({ status: 'ok', hasEarlier: true, hasLater: false });
    if (latest.status !== 'ok') throw new Error('latest_window_unavailable');
    await staging.addWindow({ kind: 'latest', limit: 10 }, latest);
    const staged = staging.finish();
    expect(Object.isFrozen(staged.changes)).toBe(true);
    expect(staged.changes).toHaveLength(10);
    expect(staging.finish()).toBe(staged);
    expect(latest.changes.map(change => change.aggregateId)).toEqual(Array.from({ length: 10 }, (_, index) => `message-${String(90 + index).padStart(3, '0')}`));
    const around = await client.readMessageWindow(manifest, { kind: 'around', anchorMessageId: 'message-010', limit: 5 });
    if (around.status !== 'ok') throw new Error('around_window_unavailable');
    expect(around.changes.map(change => change.aggregateId)).toEqual(['message-008', 'message-009', 'message-010', 'message-011', 'message-012']);
    await expect(staging.addWindow({ kind: 'around', anchorMessageId: 'message-010', limit: 5 }, around))
      .rejects.toThrow('already_published');
  });

  it('validates Renderer paged and scoped reads through the same production query owner', async () => {
    const store = createStore();
    await store.append(commit(1, [decisionChange(1)]));
    const client = new ProjectionRuntimeClient({
      request: async command => ({ ok: true, value: await readAgentProjectionQuery(store, command) }),
      getStatus: async () => { throw new Error('status_not_used'); },
      onEvent: () => () => undefined, onStatus: () => () => undefined
    });
    const manifest = await client.beginScopeSnapshot({ kind: 'decisions' });
    expect(await client.readScopePage(manifest)).toMatchObject({ status: 'ok', manifest, hasMore: false });
    const settled = decisionChange(1);
    if (settled.feature !== 'decisions' || settled.dto === null) throw new Error('test_decision_missing');
    const { action: _action, ...dto } = settled.dto;
    await store.append(commit(2, [{ ...settled, aggregateVersion: 2,
      dto: { ...dto, version: 2, status: 'approved', resolvedAt: NOW } }]));
    const request = { readContractVersion: '1.0', scope: manifest.scope, streamId: manifest.streamId,
      afterCursor: manifest.boundaryCursor, afterDigest: manifest.boundaryDigest, limit: 128 };
    const scanned = await client.readScopedCommits(request);
    expect(scanned).toMatchObject({ status: 'ok', nextCursor: manifest.boundaryCursor + 1,
      entries: [{ changes: [{ aggregateVersion: 2, dto: { status: 'approved' } }] }] });
    const mismatched = new ProjectionRuntimeClient({
      request: async () => ({ ok: true, value: { kind: 'projection.scope.batch', batch: scanned } }),
      getStatus: async () => { throw new Error('status_not_used'); },
      onEvent: () => () => undefined, onStatus: () => () => undefined
    });
    await expect(mismatched.readScopedCommits({ ...request, scope: { kind: 'tasks' } }))
      .rejects.toThrow('projection_protocol_integrity_error:public_projection_scoped_read_request_mismatch');
  });

  it('stages 130 Decisions across pages at one boundary and observes settlement only on the next read', async () => {
    const store = createStore();
    await store.append(commit(1, Array.from({ length: 130 }, (_, index) => decisionChange(index))));
    const commands: RuntimeCommand[] = [];
    let mutate = true;
    const source = new DecisionNotificationSource(async command => {
      commands.push(command);
      const result = await readAgentProjectionQuery(store, command);
      if (mutate && command.kind === 'projection.catalog.page') {
        mutate = false;
        const settled = decisionChange(129);
        if (settled.feature !== 'decisions' || settled.dto === null) throw new Error('test_decision_missing');
        const { action: _action, ...dto } = settled.dto;
        await store.append(commit(2, [{ ...settled, aggregateVersion: 2,
          dto: { ...dto, version: 2, status: 'approved', resolvedAt: NOW } }, decisionChange(130, 'user_question')]));
      }
      return result;
    });
    const first = await source.read();
    expect(first).toHaveLength(130);
    expect(first.find(item => item.decisionId === id(129))?.version).toBe(1);
    expect(first.some(item => item.decisionId === id(130))).toBe(false);
    expect(commands.map(command => command.kind)).toEqual([
      'projection.catalog.begin', 'projection.catalog.page', 'projection.catalog.page'
    ]);
    expect(Object.keys(first[0]!).sort()).toEqual(['decisionId', 'kind', 'runId', 'sessionId', 'status', 'title', 'version']);
    const second = await source.read();
    expect(second).toHaveLength(130);
    expect(second.some(item => item.decisionId === id(129))).toBe(false);
    expect(second.find(item => item.decisionId === id(130))).toMatchObject({ kind: 'user_question', status: 'pending' });
    expect(JSON.stringify(second)).not.toContain('decision-action');
  });

  it('rejects a reset in the second page without returning the first partial pending set', async () => {
    const store = createStore();
    await store.append(commit(1, Array.from({ length: 130 }, (_, index) => decisionChange(index))));
    let pages = 0;
    const source = new DecisionNotificationSource(async command => {
      if (command.kind === 'projection.catalog.page' && ++pages === 2) return {
        kind: 'projection.catalog.page_result', page: { status: 'reset_required', reason: 'snapshot_expired', streamId: store.streamId }
      };
      return readAgentProjectionQuery(store, command);
    });
    await expect(source.read()).rejects.toThrow('projection_catalog_reset_required:snapshot_expired');
  });

  it('revalidates a settled notification target through minimal summaries and rejects changed ownership', async () => {
    const store = createStore(), commands: RuntimeCommand[] = [];
    await store.append(commit(1, [decisionChange(0, 'user_question')]));
    const source = new DecisionNotificationSource(async command => { commands.push(command); return readAgentProjectionQuery(store, command); });
    const pending = (await source.read())[0]!;
    const original = decisionChange(0, 'user_question');
    if (original.feature !== 'decisions' || original.dto === null) throw new Error('fixture_decision_missing');
    const { action: _action, ...dto } = original.dto;
    await store.append(commit(2, [{ ...original, aggregateVersion: 2, dto: { ...dto, version: 2, status: 'approved', resolvedAt: NOW } }]));
    commands.length = 0;
    const current = await source.readCurrent(pending);
    expect(current).toMatchObject({ decisionId: pending.decisionId, status: 'approved', version: 2 });
    expect(commands.map(command => command.kind)).toEqual(['projection.catalog.begin', 'projection.catalog.page']);
    expect(JSON.stringify(current)).not.toContain('Question text'); expect(JSON.stringify(current)).not.toContain('decision-action');
    expect(await source.readCurrent({ ...pending, runId: 'different-run' })).toBeNull();
    expect(await source.readCurrent({ ...pending, sessionId: 'different-session' })).toBeNull();
  });
});

function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-decision-pages-'));
  roots.push(root);
  const store = new SqlitePublicProjectionStore(root);
  stores.push(store);
  return store;
}
function id(index: number) { return `decision-${String(index).padStart(3, '0')}`; }
function commit(cursor: number, changes: PublicProjectionChange[]): ProjectionCommit {
  return { contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, eventId: `decisions-${cursor}`,
    sourceId: 'test-decisions', sourceCursor: cursor, occurredAt: NOW, changes };
}
function decisionChange(index: number, kind: 'permission' | 'user_question' = 'permission'): PublicProjectionChange {
  const dto: PublicDecisionProjection = kind === 'permission' ? {
    decisionId: id(index), sessionId: 'session-1', runId: 'run-1', version: 1, kind,
    status: 'pending', requestedAt: NOW,
    presentation: { contractVersion: '1.0', kind, headline: `Permission ${index}`,
      summary: 'Bounded action', toolName: 'tool.safe_action', capabilityIds: ['capability.safe'],
      scopeIds: ['scope.workspace'], resourceSummary: 'One resource' },
    action: { contractVersion: '1.0', actionToken: `decision-action.v1:${'a'.repeat(64)}`,
      choices: ['allow_once', 'allow_run', 'deny'] }
  } : {
    decisionId: id(index), sessionId: 'session-1', runId: 'run-1', version: 1, kind,
    status: 'pending', requestedAt: NOW,
    presentation: { contractVersion: '1.0', kind, headline: 'User question',
      question: 'Question text must not enter the notification DTO', allowsFreeText: true },
    action: { contractVersion: '1.0', actionToken: `decision-action.v1:${'a'.repeat(64)}`, choices: ['answer'] }
  };
  return { feature: 'decisions', operation: 'upsert', aggregateId: dto.decisionId,
    aggregateVersion: dto.version, projectedAt: NOW, dto };
}
