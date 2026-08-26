import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { PublicAgentObservability } from '../src/adapters/observability/PublicAgentObservability.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PublicAgentObservability', () => {
  it('persists redacted Hook diagnostics and deduplicates stable deliveries', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-observability-'));
    roots.push(root);
    const store = new SqlitePublicProjectionStore(root);
    const observability = new PublicAgentObservability(store, store);
    await observability.start();
    const delivery = {
      deliveryId: `hook-delivery:${'a'.repeat(64)}`,
      hookId: 'audit', hookVersion: '1', event: 'tool.dispatch.post' as const,
      outcome: 'observed' as const, observedAt: '2030-01-01T00:00:00.000Z'
    };
    observability.record(delivery);
    observability.record(delivery);
    await observability.drain();

    const snapshot = await store.snapshot();
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({
      severity: 'info', code: 'AGENT_HOOK_TOOL_DISPATCH_POST_OBSERVED',
      message: 'Agent lifecycle Hook tool.dispatch.post observed.'
    });
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain('audit');
    await store.close();
  });
});
