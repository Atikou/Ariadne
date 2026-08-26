import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
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
    const snapshot = await supervisor.request({
      kind: 'projection.snapshot.get',
      contractVersion: '3.0'
    });
    expect(snapshot).toMatchObject({ kind: 'projection.snapshot' });
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'ready',
      protocolVersion: '3.0'
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

    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-crash' }
    )).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false,
      correlationId: 'command-crash'
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);

    expect(statuses).toContain('crashed');
    expect(statuses).toContain('restarting');
    expect(supervisor.getStatus().availability).toBe('ready');
  }, 15_000);

  it('does not send a request cancelled while the Runtime handshake is pending', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'delayed_ready_abort_gate'
    }, []);
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const controller = new AbortController();

    const result = supervisor.request(
      { kind: 'runtime.status.get' },
      {
        commandId: 'command-cancel-during-start',
        signal: controller.signal
      }
    );
    setTimeout(() => controller.abort(), 20);

    await expect(result).rejects.toMatchObject({
      code: 'runtime_request_cancelled',
      retryable: false,
      correlationId: 'command-cancel-during-start'
    });
    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-after-start-cancel' }
    )).resolves.toMatchObject({ kind: 'runtime.status' });
  }, 15_000);

  it('uses a stable command id and sends an explicit cancel when a request deadline expires', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, {
      ...process.env,
      ARIADNE_TEST_RUNTIME_BEHAVIOR: 'cancel_gate'
    }, []);
    options.requestTimeoutMs = 30;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    await supervisor.start();

    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-timeout' }
    )).rejects.toMatchObject({
      code: 'runtime_request_timeout',
      correlationId: 'command-timeout'
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(supervisor.request(
      { kind: 'runtime.status.get' },
      { commandId: 'command-after-cancel', timeoutMs: 1_000 }
    )).resolves.toMatchObject({ kind: 'runtime.status' });
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
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
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

  it('rejects a Runtime from a different build even when package versions match', async () => {
    const supervisor = createSupervisor(
      path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs'),
      {
        ...process.env,
        ARIADNE_TEST_RUNTIME_BUILD_FINGERPRINT: 'b'.repeat(64)
      },
      []
    );

    await expect(supervisor.start()).rejects.toMatchObject({
      code: 'runtime_protocol_violation'
    });
    await waitUntil(() => supervisor.getStatus().availability === 'disabled');
  }, 15_000);

  it('restarts a ready Runtime before the next request when its build manifest changes', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    const manifestPath = path.join(options.dataRoot, 'runtime-build.json');
    writeBuildManifest(manifestPath, 'a'.repeat(64));
    delete options.runtimeBuildFingerprint;
    options.runtimeBuildManifestPath = manifestPath;
    const supervisor = new RuntimeSupervisor(options);
    supervisors.push(supervisor);
    const readyFingerprints: string[] = [];
    supervisor.onStatus((status) => {
      if (status.availability === 'ready' && status.runtimeBuildFingerprint) {
        readyFingerprints.push(status.runtimeBuildFingerprint);
      }
    });
    await supervisor.start();

    writeBuildManifest(manifestPath, 'b'.repeat(64));
    await expect(supervisor.request({ kind: 'runtime.status.get' }))
      .resolves.toMatchObject({ kind: 'runtime.status' });

    expect(readyFingerprints).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(supervisor.getStatus().runtimeBuildFingerprint).toBe('b'.repeat(64));
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
        expect(observedEvents).toContain('trace.appended');
      });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 15_000);

  it('discards queued events from an old Runtime epoch after restart', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const supervisor = new RuntimeSupervisor(
      createSupervisorOptions(runtimeEntry, process.env, [])
    );
    supervisors.push(supervisor);
    const oldChild = {};
    const newChild = {};
    const internals = supervisor as unknown as {
      child: object | null;
      runtimeInstanceId: string | null;
      lastEventCursor: number;
      eventDeliveryQueue: Promise<void>;
      handleMessage(child: object, raw: unknown): void;
    };
    internals.child = oldChild;
    internals.runtimeInstanceId = '11111111-1111-4111-8111-111111111111';
    internals.lastEventCursor = 1;
    const observed: string[] = [];
    supervisor.onEvent((event) => observed.push(event.eventId));

    internals.handleMessage(
      oldChild,
      runtimeEventMessage('11111111-1111-4111-8111-111111111111', 3, 'old-event-3')
    );
    const oldEpochQueue = internals.eventDeliveryQueue;
    internals.child = newChild;
    internals.runtimeInstanceId = '22222222-2222-4222-8222-222222222222';
    internals.lastEventCursor = 0;
    internals.eventDeliveryQueue = Promise.resolve();
    internals.handleMessage(
      newChild,
      runtimeEventMessage('22222222-2222-4222-8222-222222222222', 1, 'new-event-1')
    );
    await internals.eventDeliveryQueue;

    await oldEpochQueue;

    expect(observed).toEqual(['new-event-1']);
    expect(internals.lastEventCursor).toBe(1);
  });

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

    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(supervisor.request({ kind: 'runtime.status.get' })).rejects.toMatchObject({
      code: 'command_outcome_uncertain',
      retryable: false
    });
    await waitUntil(() => statuses.filter((status) => status === 'ready').length === 3);

    expect(supervisor.getStatus().availability).toBe('ready');
    expect(statuses).not.toContain('disabled');
  }, 15_000);

  it('blocks replacement when termination does not produce a confirmed child exit', async () => {
    const runtimeEntry = path.resolve(process.cwd(), 'tests', 'fixtures', 'runtime-fixture.cjs');
    const options = createSupervisorOptions(runtimeEntry, process.env, []);
    options.shutdownTimeoutMs = 40;
    const supervisor = new RuntimeSupervisor(options);
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => false),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null))
    });
    const internals = supervisor as unknown as {
      child: typeof child | null;
      runtimeInstanceId: string | null;
      currentStatus: { availability: string };
    };
    internals.child = child;
    internals.runtimeInstanceId = '11111111-1111-4111-8111-111111111111';
    internals.currentStatus = {
      availability: 'ready',
      capabilities: [],
      observedAt: new Date().toISOString()
    } as never;

    await expect(supervisor.restart(options)).rejects.toMatchObject({
      code: 'runtime_process_exit_timeout',
      retryable: false
    });

    expect(child.kill).toHaveBeenCalled();
    expect(internals.child).toBe(child);
    expect(supervisor.getStatus()).toMatchObject({
      availability: 'crashed',
      detail: expect.stringContaining('replacement is blocked')
    });
    internals.child = null;
  });
});

function runtimeEventMessage(runtimeInstanceId: string, cursor: number, eventId: string) {
  return {
    protocol: 'ariadne_runtime',
    protocolVersion: '3.0',
    runtimeInstanceId,
    type: 'event',
    event: {
      eventId,
      cursor,
      schemaVersion: '2.0',
      aggregateType: 'trace',
      aggregateId: eventId,
      aggregateVersion: cursor,
      occurredAt: new Date().toISOString(),
      event: {
        kind: 'trace.appended',
        entry: {
          traceId: eventId,
          level: 'info',
          category: 'supervisor-test',
          message: 'Runtime event delivery test.',
          occurredAt: new Date().toISOString()
        }
      }
    }
  } as const;
}

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
    ...(runtimeEntry.includes('runtime-fixture')
      ? { runtimeBuildFingerprint: 'a'.repeat(64) }
      : {
          runtimeBuildManifestPath: path.resolve(
            process.cwd(),
            '..',
            'runtime',
            'dist',
            'runtime-build.json'
          )
        }),
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
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
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
    handshakeTimeoutMs: 15_000,
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

function writeBuildManifest(filePath: string, fingerprint: string): void {
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: '0.1.0',
    fingerprint
  }));
}
