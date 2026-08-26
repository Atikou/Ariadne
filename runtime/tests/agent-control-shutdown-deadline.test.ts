import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const children = new Set<ChildProcessWithoutNullStreams>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child);
    }
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Control shutdown deadline fencing', () => {
  it('retains the owner fence after an uncooperative transaction misses the deadline, until child kill', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ariadne-agent-shutdown-deadline-'));
    roots.push(root);
    const child = spawnUncooperativeAgentOwner(root);
    children.add(child);
    await waitForLine(child, 'AGENT_SHUTDOWN_DEADLINE_MISSED');

    let unexpectedOwner: SqliteAgentRunUnitOfWork | undefined;
    try {
      expect(() => {
        unexpectedOwner = new SqliteAgentRunUnitOfWork(root);
      }).toThrow(/sqlite_owner_lease_unavailable:agent-control/);
    } finally {
      if (unexpectedOwner !== undefined) await closeUnitOfWork(unexpectedOwner);
    }

    child.kill();
    await waitForExit(child);
    children.delete(child);

    const replacement = new SqliteAgentRunUnitOfWork(root);
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await replacement.close(context);
    } finally {
      context.dispose();
    }
  });
});

function spawnUncooperativeAgentOwner(root: string): ChildProcessWithoutNullStreams {
  const script = String.raw`
    import { SqliteAgentRunUnitOfWork } from './src/adapters/persistence/SqliteAgentRunUnitOfWork.ts';
    import { createShutdownContext } from './src/ingress/ShutdownContext.ts';

    let owner = new SqliteAgentRunUnitOfWork(process.argv[1]);
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    void owner.transaction(async () => {
      markStarted();
      await new Promise(() => {});
    });
    await started;

    const context = createShutdownContext(Date.now() + 25);
    owner.prepareShutdown(context);
    void owner.close(context).then(
      () => process.stdout.write('UNEXPECTED_AGENT_CLOSE\n'),
      () => process.stdout.write('AGENT_CLOSE_REJECTED\n')
    );
    setInterval(() => {}, 10_000);
    await new Promise((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener('abort', resolve, { once: true });
    });
    owner = undefined;
    for (let index = 0; index < 5; index += 1) globalThis.gc();
    process.stdout.write('AGENT_SHUTDOWN_DEADLINE_MISSED\n');
  `;
  return spawn(process.execPath, [
    '--expose-gc',
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    script,
    root
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function closeUnitOfWork(unitOfWork: SqliteAgentRunUnitOfWork): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unitOfWork.close(context);
  } finally {
    context.dispose();
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`agent_shutdown_child_timeout:${stdout}:${stderr}`));
    }, 5_000);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(`${expected}\n`)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`agent_shutdown_child_exited:${String(code)}:${String(signal)}:${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
