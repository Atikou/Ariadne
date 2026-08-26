import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessObserver,
  AgentProcessRequest
} from '../src/control/ports/AgentProcessSandbox.js';
import { AgentProcessSessionService } from '../src/control/resources/AgentProcessSessionService.js';

describe('AgentProcessSessionService', () => {
  it('keeps one owned process across separate start, write, read, list and stop operations', async () => {
    const harness = processHarness();
    const service = new AgentProcessSessionService(() => harness.sandbox);
    const owner = { runId: 'run-1', workspaceId: 'workspace-1' };
    const started = service.start({
      owner,
      idempotencyKey: 'effect-start-1',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: ['repl.js'],
      cwd: 'C:\\workspace'
    });

    expect(started).toMatchObject({ status: 'running', pid: 42 });
    expect(service.start({
      owner,
      idempotencyKey: 'effect-start-1',
      workspaceRoot: 'C:\\workspace',
      command: 'ignored.exe',
      args: [],
      cwd: 'C:\\workspace'
    }).resourceId).toBe(started.resourceId);
    expect(harness.openFileLease).toHaveBeenCalledTimes(1);

    harness.stdout('ready> ');
    await service.write(owner, started.resourceId, '1 + 1', true);
    expect(harness.writeStdin).toHaveBeenCalledWith('1 + 1\n');
    harness.stdout('2\nready> ');
    harness.stderr('notice\n');

    const first = service.read(owner, started.resourceId, 0, 8);
    expect(first.chunks.map((chunk) => chunk.text).join('')).toBe('ready> 2');
    const second = service.read(owner, started.resourceId, first.nextCursor);
    expect(second.chunks).toEqual([
      { cursor: 8, stream: 'stdout', text: '\nready> ' },
      { cursor: 16, stream: 'stderr', text: 'notice\n' }
    ]);
    expect(service.list(owner)).toHaveLength(1);

    const stopping = service.stop(owner, started.resourceId);
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    harness.complete({ errorCode: 'cancelled' });
    await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
  });

  it('rejects a resource id presented by a different Run or workspace owner', () => {
    const harness = processHarness();
    const service = new AgentProcessSessionService(() => harness.sandbox);
    const session = service.start({
      owner: { runId: 'run-owner', workspaceId: 'workspace-owner' },
      idempotencyKey: 'effect-owner',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: [],
      cwd: 'C:\\workspace'
    });

    expect(() => service.read(
      { runId: 'run-foreign', workspaceId: 'workspace-owner' },
      session.resourceId
    )).toThrow('process_session_not_found');
    expect(() => service.read(
      { runId: 'run-owner', workspaceId: 'workspace-foreign' },
      session.resourceId
    )).toThrow('process_session_not_found');
    expect(service.list({ runId: 'run-foreign', workspaceId: 'workspace-owner' })).toEqual([]);
  });

  it('cancels and joins every live lease during Runtime shutdown', async () => {
    const first = processHarness();
    const second = processHarness();
    const harnesses = [first, second];
    const service = new AgentProcessSessionService(() => harnesses.shift()!.sandbox);
    for (const id of ['one', 'two']) {
      service.start({
        owner: { runId: 'run-close', workspaceId: 'workspace-close' },
        idempotencyKey: id,
        workspaceRoot: 'C:\\workspace',
        command: 'node.exe',
        args: [id],
        cwd: 'C:\\workspace'
      });
    }

    const closing = service.close();
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    first.complete({ errorCode: 'cancelled' });
    second.complete({ errorCode: 'cancelled' });
    await expect(closing).resolves.toBeUndefined();
  });
});

function processHarness() {
  let observer: AgentProcessObserver | undefined;
  let resolveCompletion!: (result: AgentProcessExecutionResult) => void;
  const completion = new Promise<AgentProcessExecutionResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const writeStdin = vi.fn(async () => undefined);
  const cancel = vi.fn();
  const lease: AgentProcessLease = {
    executionId: 'execution-1',
    completion,
    cancel,
    writeStdin,
    endStdin: vi.fn(async () => undefined)
  };
  const openFileLease = vi.fn((request: AgentProcessRequest, nextObserver?: AgentProcessObserver) => {
    observer = nextObserver;
    observer?.onStarted?.({ executionId: lease.executionId, pid: 42 });
    return lease;
  });
  const sandbox = {
    mode: 'workspace-write' as const,
    runFile: vi.fn(),
    openFileLease
  };
  const baseResult: AgentProcessExecutionResult = {
    executionId: lease.executionId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    spawnFailed: false,
    isolation: {
      backend: 'windows-native',
      enforced: true,
      mode: 'workspace-write',
      networkMode: 'offline'
    }
  };
  return {
    sandbox,
    openFileLease,
    writeStdin,
    cancel,
    stdout: (text: string) => observer?.onStdout?.(Buffer.from(text)),
    stderr: (text: string) => observer?.onStderr?.(Buffer.from(text)),
    complete: (overrides: Partial<AgentProcessExecutionResult> = {}) => {
      resolveCompletion({ ...baseResult, ...overrides });
    }
  };
}
