import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARIADNE_RUNTIME_PROTOCOL, ARIADNE_RUNTIME_PROTOCOL_VERSION, type RuntimeBootstrap } from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { createRuntimeKernelApplicationFactory } from '../src/application/RuntimeKernelApplication.js';
import { compileProductionRuntimeCapabilityManifest } from '../src/composition/ProductionRuntimeCapabilityManifest.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('remote text availability through the production kernel', () => {
  it('uses the configured model, probes without reasoning, and admits text chat only after a real stream', async () => {
    await withKernel(async (application, calls) => {
      expect(application.modelCatalog.snapshot()).toContainEqual(expect.objectContaining({
        id: 'deepseek-flash', enabled: true, supportsTextChat: false
      }));
      const check = (modelId: string) => application.execute({ commandId: randomUUID(), correlationId: randomUUID(),
        command: { kind: 'model.availability.check', contractVersion: '5.0', modelId },
        deadlineAt: new Date(Date.now() + 30_000).toISOString(), signal: new AbortController().signal });
      expect(await check('cloud-deepseek')).toMatchObject({ outcome: { ok: true, result: { available: false } } });
      expect(calls).toHaveLength(0);
      expect(await check('deepseek-flash')).toMatchObject({ outcome: { ok: true, result: { available: true } } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 256,
        messages: [{ role: 'user', content: 'Reply with READY.' }], stream: true });
      expect(calls[0]).not.toHaveProperty('temperature');
      expect(application.modelCatalog.snapshot()).toContainEqual(expect.objectContaining({
        id: 'deepseek-flash', supportsTextChat: true, supportsAgent: false, supportsPlan: false, supportsVision: false
      }));
      expect(application.modelInferenceGateway!.resolveBinding(7, { modelId: 'deepseek-flash', executionMode: 'chat' }))
        .toMatchObject({ modelId: 'deepseek-flash' });
      expect(() => application.modelInferenceGateway!.resolveBinding(7, { modelId: 'deepseek-flash', executionMode: 'agent' }))
        .toThrow('model_agent_qualification_required');
    });
  });

  it.each(['length', 'wrong-model', 'http-error'] as const)('does not grant text capability on %s', async mode => {
    await withKernel(async (application, calls) => {
      expect(await application.execute({ commandId: randomUUID(), correlationId: randomUUID(),
        command: { kind: 'model.availability.check', contractVersion: '5.0', modelId: 'deepseek-flash' },
        deadlineAt: new Date(Date.now() + 30_000).toISOString(), signal: new AbortController().signal }))
        .toMatchObject({ outcome: { ok: true, result: { available: false } } });
      expect(calls).toHaveLength(1);
      expect(application.modelCatalog.snapshot()[0]?.supportsTextChat).toBe(false);
    }, mode);
  });
});

async function withKernel(
  run: (application: Awaited<ReturnType<ReturnType<typeof createRuntimeKernelApplicationFactory>['create']>>, calls: unknown[]) => Promise<void>,
  mode = 'success'
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-remote-availability-'));
  const calls: unknown[] = [];
  vi.stubEnv('AVAILABILITY_FIXTURE_KEY', 'fixture-only-secret');
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    if (mode === 'http-error') return new Response('', { status: 401 });
    const model = mode === 'wrong-model' ? 'unexpected-model' : 'deepseek-flash';
    return new Response([
      { model, choices: [{ index: 0, delta: { content: 'READY' }, finish_reason: null }] },
      { model, choices: [{ index: 0, delta: {}, finish_reason: mode === 'length' ? 'length' : 'stop' }] },
      { model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  }));
  const bootstrap: RuntimeBootstrap = {
    protocol: ARIADNE_RUNTIME_PROTOCOL, protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION, type: 'bootstrap',
    runtimeInstanceId: randomUUID(), appVersion: '0.1.0', runtimeVersion: '0.1.0', runtimeBuildFingerprint: 'a'.repeat(64),
    installRoot: path.resolve('.'), dataRoot: root, modelRoots: [], workspaces: [], production: false, profile: 'default',
    runtimePolicy: { ...createDefaultRuntimePolicySnapshot(), providerResilience: {
      ...createDefaultRuntimePolicySnapshot().providerResilience, maxAttempts: 1
    } },
    modelProviders: [{ providerId: 'deepseek', name: 'cloud-deepseek', model: 'deepseek-flash', enabled: true,
      baseUrl: 'https://provider.example', protocol: 'openai-compatible', usageReporting: 'openai-stream-options',
      credentialEnvironmentVariable: 'AVAILABILITY_FIXTURE_KEY', contextWindowTokens: 32768, maxOutputTokens: 4096,
      inference: { reasoning: { modes: ['off', 'on'], defaultMode: 'on', efforts: ['high'], defaultEffort: 'high' } } }],
    agentAdmissionAuthoritySource: { sourceVersion: 1, status: 'enabled', manifests: [{
      manifestVersion: 1, manifestId: 'availability-fixture', revision: 1,
      workspace: { workspaceId: 'fixture', revision: 1, grantDigest: `sha256:${'a'.repeat(64)}`, access: 'read', scopeIds: ['fixture'] },
      model: { providerId: 'deepseek', modelId: 'deepseek-flash', settingsRevision: 7 },
      policy: { policyId: 'policy', revision: 1, permissionMode: 'ask' },
      capabilityGrant: { grantId: 'grant', revision: 1, capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['fixture'] }] },
      toolCatalog: { catalogId: 'catalog', revision: 1, digest: `sha256:${'a'.repeat(64)}`, allowedToolNames: ['workspace.read'] },
      rootBudget: { authorityId: 'budget', revision: 1,
        vector: { modelTurns: 2, toolCalls: 1, readCalls: 1, writeCalls: 0, shellCalls: 0, costMicrousd: 1000 },
        deadlinePolicy: { kind: 'absolute', deadlineAt: '2099-01-01T00:00:00.000Z' } }
    }] }
  };
  const manifest = await compileProductionRuntimeCapabilityManifest({ bootstrap });
  const application = await createRuntimeKernelApplicationFactory().create({ bootstrap, capabilityManifest: manifest,
    emitEvent: () => {}, runtimeVersion: '0.1.0' });
  const shutdown = createShutdownContext(Date.now() + 30_000);
  try { await application.start(); await run(application, calls); }
  finally {
    await application.shutdown(shutdown); await manifest.close(shutdown); shutdown.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}
