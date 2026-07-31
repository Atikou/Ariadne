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
import type { RuntimeCommand } from '@ariadne/protocol/public';
import { createDefaultRuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { afterEach, describe, expect, it } from 'vitest';

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
  it('handshakes, persists a Companion session, and shuts down through Node IPC', async () => {
    const child = startChild();
    const inbox = createInbox(child);
    const bootstrap = createBootstrap();
    child.send(bootstrap);

    const ready = await inbox.next(
      (message): message is Extract<RuntimeToHostMessage, { type: 'ready' }> => message.type === 'ready'
    );
    expect(ready.type).toBe('ready');
    if (ready.type !== 'ready') throw new Error('unreachable');
    expect(ready.capabilities).toContain('companion.chat');
    expect(ready.capabilities).toContain('companion.agent-plan');
    expect(ready.storageSchemas).toMatchObject({ memory: 42, companion: 9, tools: 2 });

    child.send(request(bootstrap, 'status-1', { kind: 'runtime.status.get' }));
    const status = await inbox.nextResponse('status-1');
    expect(status.outcome).toMatchObject({
      ok: true,
      result: { kind: 'runtime.status', status: { availability: 'ready' } }
    });

    child.send(request(bootstrap, 'session-create', {
      kind: 'companion.sessions.create',
      workspaceId: 'secondary',
      title: 'IPC integration'
    }));
    const created = await inbox.nextResponse('session-create');
    expect(created.outcome).toMatchObject({
      ok: true,
      result: {
        kind: 'companion.session',
        session: { title: 'IPC integration', workspaceId: 'secondary' }
      }
    });

    child.send(request(bootstrap, 'session-list', { kind: 'companion.sessions.list' }));
    const listed = await inbox.nextResponse('session-list');
    expect(listed.outcome.ok).toBe(true);
    if (!listed.outcome.ok || listed.outcome.result.kind !== 'companion.sessions') {
      throw new Error('unexpected session list result');
    }
    expect(listed.outcome.result.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'IPC integration', workspaceId: 'secondary' })
    ]));

    child.send(request(bootstrap, 'session-create-invalid-workspace', {
      kind: 'companion.sessions.create',
      workspaceId: 'untrusted'
    }));
    const rejected = await inbox.nextResponse('session-create-invalid-workspace');
    expect(rejected.outcome).toMatchObject({
      ok: false,
      error: { code: 'workspace_not_authorized' }
    });

    child.send(request(bootstrap, 'plan-chat-start', {
      kind: 'companion.chat.start',
      clientMessageId: 'plan-chat-user',
      workspaceId: 'primary',
      modelId: 'cloud-openai',
      message: 'Create a read-only implementation plan',
      agentMode: 'plan',
      resources: []
    }));
    const planAccepted = await inbox.nextResponse('plan-chat-start');
    expect(planAccepted.outcome, JSON.stringify(planAccepted.outcome)).toMatchObject({
      ok: true,
      result: {
        kind: 'companion.chat.accepted',
        executionMode: 'agent-plan'
      }
    });

    const exit = waitForExit(child);
    child.send({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: bootstrap.runtimeInstanceId,
      type: 'shutdown',
      requestId: 'shutdown-1',
      reason: 'user_request',
      deadlineMs: 10_000
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
    command
  };
}

function createInbox(child: ChildProcess) {
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
    throw new Error('runtime message timeout');
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
