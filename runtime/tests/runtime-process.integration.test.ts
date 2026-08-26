import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  parseRuntimeToHostMessage,
  type RuntimeBootstrap,
  type RuntimeToHostMessage
} from '@ariadne/protocol/host';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type PublicModelProjectionV3,
  type RuntimeCommand
} from '@ariadne/protocol/public';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_CONTROL_DB_SCHEMA_VERSION } from '../src/adapters/persistence/agentControlDbSchema.js';
import { CONVERSATION_DB_SCHEMA_VERSION } from '../src/adapters/persistence/ConversationDbSchema.js';
import { PUBLIC_PROJECTION_DB_SCHEMA_VERSION } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { RUNTIME_COMMAND_DB_SCHEMA_VERSION } from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import { projectionWakeAggregateId } from '../src/composition/PublicProjectionWakeCommitSink.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEntry = path.join(packageRoot, 'dist', 'entry', 'runtime-process.js');
const children = new Set<ChildProcess>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all([...children].map((child) => stopChild(child)));
  children.clear();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('portless Runtime process', () => {
  it('handshakes, persists a v3 Conversation session, and shuts down through Node IPC', async () => {
    const child = startChild();
    const stderr = collectStderr(child);
    const inbox = createInbox(child, stderr);
    const bootstrap = createBootstrap();
    child.send(bootstrap);

    const ready = await inbox.next(
      (message): message is Extract<RuntimeToHostMessage, { type: 'ready' }> => message.type === 'ready'
    );
    expect(ready.type).toBe('ready');
    if (ready.type !== 'ready') throw new Error('unreachable');
    expect(ready.capabilities).toContain('agent.tools');
    expect(ready.capabilities).toContain('companion.agent-plan');
    expect(ready.storageSchemas).toEqual({
      runtimeCommand: RUNTIME_COMMAND_DB_SCHEMA_VERSION,
      agentControl: AGENT_CONTROL_DB_SCHEMA_VERSION,
      conversation: CONVERSATION_DB_SCHEMA_VERSION,
      publicProjection: PUBLIC_PROJECTION_DB_SCHEMA_VERSION
    });

    child.send(request(bootstrap, 'status-1', { kind: 'runtime.status.get' }));
    const status = await inbox.nextResponse('status-1');
    expect(status.outcome).toMatchObject({
      ok: true,
      result: { kind: 'runtime.status', status: { availability: 'ready' } }
    });

    let projectedModel: PublicModelProjectionV3 | undefined;
    let serializedProjection = '';
    const modelDeadline = Date.now() + 10_000;
    let projectionAttempt = 0;
    while (Date.now() < modelDeadline) {
      projectionAttempt += 1;
      const requestId = `projection-model-${String(projectionAttempt)}`;
      child.send(request(bootstrap, requestId, {
        kind: 'projection.snapshot.get',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
      }));
      const response = await inbox.nextResponse(requestId);
      serializedProjection = JSON.stringify(response.outcome);
      if (
        response.outcome.ok
        && response.outcome.result.kind === 'projection.snapshot'
      ) {
        projectedModel = response.outcome.result.snapshot.models.find(
          (model) => model.modelId === 'runtime-process-test-model'
        );
        if (projectedModel?.availability === 'ready') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(projectedModel).toMatchObject({
      modelId: 'runtime-process-test-model',
      label: 'runtime-process-test-model',
      location: 'remote',
      availability: 'ready',
      supportsVision: false
    });
    expect(projectedModel?.version).toBeGreaterThan(0);
    expect(serializedProjection).not.toContain('runtime-process-test-key');
    expect(serializedProjection).not.toContain('ARIADNE_RUNTIME_PROCESS_TEST_KEY');
    expect(serializedProjection).not.toContain('https://127.0.0.1:1/v1');
    const modelWake = await inbox.next(
      (message): message is Extract<RuntimeToHostMessage, { type: 'event' }> =>
        message.type === 'event'
        && message.event.event.kind === 'projection.changed'
        && message.event.event.feature === 'models'
    );
    expect(modelWake.event).toMatchObject({
      aggregateType: 'projection',
      aggregateId: projectionWakeAggregateId('model-catalog', 'models'),
      event: { kind: 'projection.changed', feature: 'models' }
    });
    const serializedWake = JSON.stringify(modelWake);
    expect(serializedWake).not.toContain('runtime-process-test-key');
    expect(serializedWake).not.toContain('https://127.0.0.1:1/v1');

    const sessionId = 'ipc-integration-session';
    child.send(request(bootstrap, 'session-create', {
      kind: 'conversation.session.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId,
      workspaceId: 'secondary'
    }));
    const created = await inbox.nextResponse('session-create');
    expect(created.outcome).toMatchObject({
      ok: true,
      result: {
        kind: 'conversation.session.created.v3',
        sessionId,
        version: 1
      }
    });

    child.send(request(bootstrap, 'session-list', {
      kind: 'projection.snapshot.get',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
    }));
    const listed = await inbox.nextResponse('session-list');
    expect(listed.outcome.ok).toBe(true);
    if (!listed.outcome.ok || listed.outcome.result.kind !== 'projection.snapshot') {
      throw new Error('unexpected session list result');
    }
    expect(listed.outcome.result.snapshot.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId, workspaceId: 'secondary' })
    ]));

    child.send(request(bootstrap, 'session-create-invalid-workspace', {
      kind: 'conversation.session.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'invalid-workspace-session',
      workspaceId: 'untrusted'
    }));
    const rejected = await inbox.nextResponse('session-create-invalid-workspace');
    expect(rejected.outcome).toMatchObject({
      ok: false,
      error: { code: 'workspace_not_authorized' }
    });

    const exit = waitForExit(child);
    child.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: bootstrap.runtimeInstanceId,
      type: 'shutdown',
      requestId: 'shutdown-1',
      reason: 'user_request',
      deadlineAt: new Date(Date.now() + 10_000).toISOString()
    });
    const shutdown = await inbox.next(
      (message): message is Extract<RuntimeToHostMessage, { type: 'shutdown_complete' }> =>
        message.type === 'shutdown_complete'
    );
    expect(shutdown.type).toBe('shutdown_complete');
    expect(await exit).toBe(0);
  }, 30_000);

  it('fails closed on malformed protocol input', async () => {
    const child = startChild();
    const stderr = collectStderr(child);
    const exit = waitForExit(child);
    child.send({ type: 'bootstrap', unexpected: true });
    expect(await exit).not.toBe(0);
    expect(stderr()).toContain('invalid_protocol_message');
  }, 15_000);

  it('fails closed when Main bootstraps a different Runtime build', async () => {
    const child = startChild();
    const stderr = collectStderr(child);
    const exit = waitForExit(child);
    const bootstrap = createBootstrap();
    child.send({
      ...bootstrap,
      runtimeBuildFingerprint: 'b'.repeat(64)
    });

    expect(await exit).not.toBe(0);
    expect(stderr()).toContain('initialization_failed');
  }, 15_000);
});

function startChild(): ChildProcess {
  const child = fork(runtimeEntry, [], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AGENT_PROFILE: 'local-only',
      ARIADNE_RUNTIME_PROCESS_TEST_KEY: 'runtime-process-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  children.add(child);
  return child;
}

function createBootstrap(): RuntimeBootstrap {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-runtime-data-'));
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-runtime-workspace-'));
  const secondaryWorkspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-runtime-workspace-secondary-'));
  temporaryRoots.push(dataRoot, workspaceRoot, secondaryWorkspaceRoot);
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    runtimeBuildFingerprint: runtimeBuildFingerprint(),
    installRoot: packageRoot,
    dataRoot,
    modelRoots: [],
    modelProviders: [{
      providerId: 'openai',
      name: 'cloud-openai',
      protocol: 'openai-compatible',
      credentialEnvironmentVariable: 'ARIADNE_RUNTIME_PROCESS_TEST_KEY',
      enabled: true,
      baseUrl: 'https://127.0.0.1:1/v1',
      model: 'runtime-process-test-model',
      inference: {}
    }],
    agentAdmissionAuthoritySource: {
      sourceVersion: 1,
      status: 'disabled',
      reason: 'not_configured'
    },
    runtimePolicy: createDefaultRuntimePolicySnapshot(),
    profile: 'default',
    workspaces: [
      {
        workspaceId: 'primary',
        label: 'Temporary workspace',
        rootPath: workspaceRoot,
        access: 'write'
      },
      {
        workspaceId: 'secondary',
        label: 'Secondary workspace',
        rootPath: secondaryWorkspaceRoot,
        access: 'write'
      }
    ],
    production: false
  };
}

function runtimeBuildFingerprint(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, 'dist', 'runtime-build.json'), 'utf8')
  ) as { fingerprint?: unknown };
  if (typeof manifest.fingerprint !== 'string') {
    throw new Error('Runtime build manifest is missing a fingerprint.');
  }
  return manifest.fingerprint;
}

function request(
  bootstrap: RuntimeBootstrap,
  requestId: string,
  command: RuntimeCommand
) {
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: bootstrap.runtimeInstanceId,
    type: 'request' as const,
    requestId,
    commandId: requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    command
  };
}

function createInbox(child: ChildProcess, stderr: () => string = () => '') {
  const messages: RuntimeToHostMessage[] = [];
  const waiters = new Set<() => void>();
  child.on('message', (raw) => {
    messages.push(parseRuntimeToHostMessage(raw));
    for (const wake of waiters) wake();
  });

  const next = async <T extends RuntimeToHostMessage>(
    predicate: (message: RuntimeToHostMessage) => message is T
  ): Promise<T> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0] as T;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve();
        }, 25);
        const wake = (): void => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
    }
    const diagnostic = stderr().trim();
    throw new Error(
      diagnostic.length > 0
        ? `runtime message timeout: ${diagnostic}`
        : 'runtime message timeout'
    );
  };

  return {
    next,
    nextResponse: (requestId: string) => next(
      (message): message is Extract<RuntimeToHostMessage, { type: 'response' }> =>
        message.type === 'response' && message.requestId === requestId
    )
  };
}

function collectStderr(child: ChildProcess): () => string {
  let output = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return () => output;
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
