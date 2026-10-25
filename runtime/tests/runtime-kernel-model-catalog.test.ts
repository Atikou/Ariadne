import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimeKernelApplicationFactory
} from '../src/application/RuntimeKernelApplication.js';
import {
  compileProductionRuntimeCapabilityManifest as compileManifest
} from '../src/composition/ProductionRuntimeCapabilityManifest.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { ModelCapabilityRegistry, qualificationDatabasePath } from '../src/model/capability/ModelCapabilityRegistry.js';
import { unknownQualification } from '../src/model/capability/ModelCapabilityQualification.js';
import { readOwnedAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';

const roots: string[] = [];
const manifests: Awaited<ReturnType<typeof compileManifest>>[] = [];
async function compileProductionRuntimeCapabilityManifest(...args: Parameters<typeof compileManifest>) {
  const manifest = await compileManifest(...args); manifests.push(manifest); return manifest;
}

afterEach(async () => {
  const shutdown = createShutdownContext(Date.now() + 5_000);
  try { for (const manifest of manifests.splice(0)) await manifest.close(shutdown); } finally { shutdown.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeKernelApplication model catalog', () => {
  it('isolates an audited bad qualification source and refuses every inference boundary without changing its bytes', async () => {
    const root = temporaryRoot('ariadne-kernel-isolated-models-');
    const dataRoot = temporaryRoot('ariadne-kernel-isolated-data-');
    const workspaceRoot = temporaryRoot('ariadne-kernel-isolated-workspace-');
    writeFileSync(path.join(root, 'Blocked Local.gguf'), Buffer.from([1, 2, 3]));
    const databasePath = qualificationDatabasePath(dataRoot), registry = new ModelCapabilityRegistry(databasePath);
    registry.write(unknownQualification({ providerId: 'fixture', modelId: 'fixture', fingerprint: `sha256:${'a'.repeat(64)}` }));
    registry.close();
    const database = new DatabaseSync(databasePath);
    try { database.prepare('UPDATE model_capability_qualification SET report_json=?').run(JSON.stringify({ private: 'must not be used' }));
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { database.close(); }
    const before = readFileSync(databasePath);
    const runtimeBootstrap = bootstrap(dataRoot, workspaceRoot, [root]);
    const capabilityManifest = await compileProductionRuntimeCapabilityManifest({ bootstrap: runtimeBootstrap });
    const application = await createRuntimeKernelApplicationFactory().create({ bootstrap: runtimeBootstrap, capabilityManifest,
      emitEvent: () => undefined, runtimeVersion: '0.1.0' });
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      await application.start();
      expect(application.status().availability).toBe('ready');
      expect(application.storageSchemas).not.toHaveProperty('modelCapability');
      let fault: unknown;
      try { application.inferenceHealth!.assertHealthy(); } catch (error) { fault = error; }
      expect(readOwnedAuthorityFault(fault)).toEqual({ source: 'inference', kind: 'integrity' });
      expect(application.modelCatalog.snapshot()).toEqual([expect.objectContaining({ id: 'blocked-local',
        availability: 'unavailable', supportsTextChat: false, supportsAgent: false })]);
      const gateway = application.modelInferenceGateway!;
      const binding = { providerId: 'ariadne.local', modelId: 'blocked-local', settingsRevision: 1 };
      for (const action of [() => gateway.resolveBinding(1), () => gateway.hasExactBinding(binding),
        () => gateway.describeExecutionQualification(binding), () => gateway.describeContextCapacity(binding)]) {
        expect(action).toThrow(fault);
      }
      const request = { binding, messages: [], tools: [], signal: new AbortController().signal };
      await expect(gateway.inferExact(request)).rejects.toBe(fault);
      await expect(gateway.countRequestTokens(request)).rejects.toBe(fault);
      expect(readFileSync(databasePath)).toEqual(before);
    } finally { await application.shutdown(shutdown); shutdown.dispose(); }
    expect(readFileSync(databasePath)).toEqual(before);
  });
  it('publishes configured local model roots through the production model catalog', async () => {
    const root = temporaryRoot('ariadne-kernel-models-');
    const dataRoot = temporaryRoot('ariadne-kernel-data-');
    const workspaceRoot = temporaryRoot('ariadne-kernel-workspace-');
    writeFileSync(path.join(root, 'Qwen Local.gguf'), Buffer.from([1, 2, 3]));

    const runtimeBootstrap = bootstrap(dataRoot, workspaceRoot, [root]);
    const capabilityManifest = await compileProductionRuntimeCapabilityManifest({
      bootstrap: runtimeBootstrap
    });
    const application = await createRuntimeKernelApplicationFactory().create({
      bootstrap: runtimeBootstrap,
      capabilityManifest,
      emitEvent: () => undefined,
      runtimeVersion: '0.1.0'
    });

    expect(application.modelCatalog.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'qwen-local',
        label: 'Qwen Local',
        location: 'local',
        availability: 'checking',
        supportsAgent: false
      })
    ]));
    expect(application.status().capabilities).toContain('models.local');
    expect(() => application.modelInferenceGateway?.resolveBinding(1, {
      executionMode: 'chat'
    })).toThrow('model_text_qualification_required');

    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      await application.disposeInitialization(shutdown);
    } finally {
      shutdown.dispose();
    }
  });

  it('does not create workspace folders during Runtime startup', async () => {
    const modelRoot = temporaryRoot('ariadne-kernel-empty-models-');
    const dataRoot = temporaryRoot('ariadne-kernel-lazy-data-');
    const workspaceRoot = temporaryRoot('ariadne-kernel-lazy-workspace-');
    const runtimeBootstrap = bootstrap(dataRoot, workspaceRoot, [modelRoot]);
    const capabilityManifest = await compileProductionRuntimeCapabilityManifest({
      bootstrap: runtimeBootstrap
    });
    const application = await createRuntimeKernelApplicationFactory().create({
      bootstrap: runtimeBootstrap,
      capabilityManifest,
      emitEvent: () => undefined,
      runtimeVersion: '0.1.0'
    });

    await application.start();
    expect(existsSync(path.join(dataRoot, 'data', 'workspaces'))).toBe(false);

    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      await application.shutdown(shutdown);
    } finally {
      shutdown.dispose();
    }
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function bootstrap(
  dataRoot: string,
  workspaceRoot: string,
  modelRoots: readonly string[]
): RuntimeBootstrap {
  mkdirSync(dataRoot, { recursive: true });
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: 'a'.repeat(64),
    installRoot: path.resolve('.'),
    dataRoot,
    modelRoots: [...modelRoots],
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'default',
    workspaces: [{
      workspaceId: 'primary',
      label: 'Project',
      rootPath: workspaceRoot,
      access: 'write'
    }],
    production: false
  };
}
