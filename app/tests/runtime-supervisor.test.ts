import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';

import { RuntimeSupervisor, type RuntimeSupervisorOptions } from '../src/main/runtime/runtime-supervisor';

const temporaryRoots: string[] = [];
const supervisors: RuntimeSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop('user_request')));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeSupervisor', () => {
  it('owns the real Runtime child and exposes only public command results', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), '..', 'runtime', 'dist', 'entry', 'runtime-process.js')
    );
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));

    await supervisor.start();
    const created = await supervisor.request({
      kind: 'companion.sessions.create',
      title: 'Desktop host integration'
    });
    expect(created).toMatchObject({
      kind: 'companion.session',
      session: { title: 'Desktop host integration' }
    });
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'ready',
      protocolVersion: '2.0'
    });
    expect(statuses).toContain('starting');
    expect(statuses).toContain('ready');
  }, 30_000);

  it('brokers private Runtime capability requests through Main before readiness', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'capability_on_bootstrap'
    }, []);
    const requests: string[] = [];
    options.capabilityHandler = async (request) => {
      requests.push(request.operation.kind);
      return { available: true };
    };
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);

    await expect(supervisor.start()).resolves.toMatchObject({ type: 'ready' });
    expect(requests).toEqual(['browser.health']);
  }, 15_000);

  it('rejects in-flight work and restarts after an unexpected child exit', async () => {
    const environment = {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'crash_on_request'
    };
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      environment,
      [10]
    );
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({
      code: 'runtime_exited'
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);

    expect(statuses).toContain('crashed');
    expect(statuses).toContain('restarting');
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('restarts the same supervised boundary when Agent settings change', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    await supervisor.restart({
      ...options,
      routingStrategy: 'cloud-first',
      modelProviders: [{
        providerId: 'openai',
        name: 'cloud-openai',
        protocol: 'openai-compatible',
        credentialEnvironmentVariable: 'OPENAI_API_KEY',
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        inference: {}
      }]
    });

    expect(statuses.filter((status) => status === 'ready')).toHaveLength(2);
    expect(statuses).toContain('stopped');
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('serializes concurrent restarts and leaves the newest configuration active', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    const first = supervisor.restart({ ...options, runtimeVersion: '0.2.0' });
    const second = supervisor.restart({ ...options, runtimeVersion: '0.3.0' });
    const [firstReady, secondReady] = await Promise.all([first, second]);

    expect(firstReady.runtimeVersion).toBe('0.2.0');
    expect(secondReady.runtimeVersion).toBe('0.3.0');
    expect(statuses.filter((status) => status === 'ready')).toHaveLength(3);
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'ready',
      runtimeVersion: '0.3.0'
    });
  }, 15_000);

  it('rejects a Runtime that reports a different version', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      {
        ...process.env,
        ARIADNE_TEST_RUNTIME_VERSION: '9.9.9'
      },
      []
    );

    await expect(supervisor.start()).rejects.toMatchObject({
      code: 'runtime_protocol_violation'
    });
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('preserves the Runtime ready payload for repeated start calls', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs')
    );

    const first = await supervisor.start();
    const second = await supervisor.start();

    expect(first.storageSchemas).toEqual({ fixture: 1 });
    expect(second).toEqual(first);
  }, 15_000);

  it('contains executable launch failures without an unhandled child error', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    options.executablePath = path.join(options.dataRoot, 'missing-runtime-node.exe');
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);

    await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('isolates failing observers from Runtime lifecycle and other observers', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs')
    );
    const observedStatuses: string[] = [];
    const observedEvents: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supervisor.onStatus(() => { throw new Error('broken status observer'); });
    supervisor.onStatus((status) => observedStatuses.push(status.availability));
    supervisor.onEvent(() => { throw new Error('broken event observer'); });
    supervisor.onEvent((event) => observedEvents.push(event.event.kind));

    try {
      await supervisor.start();
      expect(supervisor.getStatus().availability).toBe('ready');
      expect(observedStatuses).toContain('ready');
      await vi.waitFor(() => {
        expect(observedEvents).toContain('runtime.status.changed');
      });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 15_000);

  it('resets the consecutive-crash budget after a stable ready interval', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'crash_on_request'
    }, [10]);
    options.restartStabilityMs = 30;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const statuses: string[] = [];
    supervisor.onStatus((status) => statuses.push(status.availability));
    await supervisor.start();

    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({ code: 'runtime_exited' });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({ code: 'runtime_exited' });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 3);

    expect(supervisor.getStatus().availability).toBe('ready');
    expect(statuses).not.toContain('disabled');
  }, 15_000);
});

function createSupervisor(
  runtimeEntry: string,
  environment: NodeJS.ProcessEnv = process.env,
  restartDelaysMs: readonly number[] = []
): RuntimeSupervisor {
  const supervisor = new RuntimeSupervisor(createSupervisorOptions(runtimeEntry, environment, restartDelaysMs));
  supervisors.push(supervisor);
  return supervisor;
}

function createSupervisorOptions(
  runtimeEntry: string,
  environment: NodeJS.ProcessEnv,
  restartDelaysMs: readonly number[]
): RuntimeSupervisorOptions {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-supervisor-data-'));
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-supervisor-workspace-'));
  temporaryRoots.push(dataRoot, workspaceRoot);
  return {
    runtimeEntry,
    installRoot: runtimeEntry.includes('runtime-fixture')
      ? path.resolve(process.cwd())
      : path.resolve(process.cwd(), '..', 'runtime'),
    dataRoot,
    modelRoots: [path.join(dataRoot, 'models')],
    modelProviders: [],
    routingStrategy: 'local-first',
    agentPermissions: {
      approvalPolicy: 'request',
      proposalApproval: 'manual',
      permissionPolicy: 'confirmBeforeRun',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    workspaces: [{
      workspaceId: 'test',
      label: 'Test workspace',
      rootPath: workspaceRoot,
      access: 'write'
    }],
    profile: 'local-only',
    appVersion: 'test',
    runtimeVersion: '0.1.0',
    production: false,
    executablePath: process.execPath,
    environment,
    restartDelaysMs,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timeout');
}
