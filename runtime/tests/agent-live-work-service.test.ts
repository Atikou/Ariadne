import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessObserver,
  AgentProcessRequest
} from '../src/control/ports/AgentProcessSandbox.js';
import { AgentLiveWorkService } from '../src/control/resources/AgentLiveWorkService.js';
import { AgentProcessLiveWorkProducer } from '../src/control/resources/AgentProcessLiveWorkProducer.js';

describe('AgentLiveWorkService with process producer', () => {
  it('accepts non-process producers without another registry or control protocol', async () => {
    const liveWork = new AgentLiveWorkService();
    const owner = { runId: 'run-generic', workspaceId: 'workspace-generic' };
    let resolveDone!: (outcome: { status: 'killed' }) => void;
    const done = new Promise<{ status: 'killed' }>((resolve) => { resolveDone = resolve; });
    const cancel = vi.fn(() => resolveDone({ status: 'killed' }));
    const job = liveWork.start(owner, {
      kind: 'subagent',
      label: 'child analysis',
      preferredId: 'job-child-analysis',
      start: (context) => {
        context.appendOutput('system', 'child ready');
        return { done, cancel };
      }
    });

    expect(liveWork.list(owner)).toEqual([expect.objectContaining({
      id: job.id,
      kind: 'subagent',
      status: 'running'
    })]);
    expect(liveWork.read(owner, job.id).chunks).toEqual([
      expect.objectContaining({ channel: 'system', text: 'child ready' })
    ]);
    await expect(liveWork.kill(owner, job.id)).resolves.toMatchObject({ status: 'killed' });
    expect(cancel).toHaveBeenCalledWith('agent_requested');
  });

  it('keeps one owned process across producer, generic job control and completion operations', async () => {
    const harness = processHarness();
    const liveWork = new AgentLiveWorkService();
    const processes = new AgentProcessLiveWorkProducer(liveWork, () => harness.sandbox);
    const owner = { runId: 'run-1', workspaceId: 'workspace-1' };
    const started = processes.start({
      owner,
      idempotencyKey: 'effect-start-1',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: ['repl.js'],
      cwd: 'C:\\workspace'
    });

    expect(started).toMatchObject({ status: 'running', kind: 'process', metadata: { processId: 42 } });
    expect(processes.start({
      owner,
      idempotencyKey: 'effect-start-1',
      workspaceRoot: 'C:\\workspace',
      command: 'ignored.exe',
      args: [],
      cwd: 'C:\\workspace'
    }).id).toBe(started.id);
    expect(harness.openFileLease).toHaveBeenCalledTimes(1);

    harness.stdout('ready> ');
    await liveWork.write(owner, started.id, '1 + 1\n');
    expect(harness.writeStdin).toHaveBeenCalledWith('1 + 1\n');
    harness.stdout('2\nready> ');
    harness.stderr('notice\n');

    const first = liveWork.read(owner, started.id, 0, 8);
    expect(first.chunks.map((chunk) => chunk.text).join('')).toBe('ready> 2');
    const second = liveWork.read(owner, started.id, first.nextCursor);
    expect(second.chunks.map(({ cursor, channel, text }) => ({ cursor, channel, text }))).toEqual([
      { cursor: 8, channel: 'stdout', text: '\nready> ' },
      { cursor: 16, channel: 'stderr', text: 'notice\n' }
    ]);
    expect(liveWork.list(owner)).toHaveLength(1);

    const stopping = liveWork.kill(owner, started.id);
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    harness.complete({ errorCode: 'cancelled' });
    await expect(stopping).resolves.toMatchObject({ status: 'killed' });
    await expect(liveWork.wait(owner, started.id, 100)).resolves.toMatchObject({ completed: true });
  });

  it('rejects a job id presented by a different Run or workspace owner', () => {
    const harness = processHarness();
    const liveWork = new AgentLiveWorkService();
    const processes = new AgentProcessLiveWorkProducer(liveWork, () => harness.sandbox);
    const job = processes.start({
      owner: { runId: 'run-owner', workspaceId: 'workspace-owner' },
      idempotencyKey: 'effect-owner',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: [],
      cwd: 'C:\\workspace'
    });

    expect(() => liveWork.read(
      { runId: 'run-foreign', workspaceId: 'workspace-owner' },
      job.id
    )).toThrow('live_work_not_found');
    expect(() => liveWork.read(
      { runId: 'run-owner', workspaceId: 'workspace-foreign' },
      job.id
    )).toThrow('live_work_not_found');
    expect(liveWork.list({ runId: 'run-foreign', workspaceId: 'workspace-owner' })).toEqual([]);
  });

  it('preserves UTF-8 scalars split across process pipe chunks', async () => {
    const harness = processHarness();
    const liveWork = new AgentLiveWorkService();
    const processes = new AgentProcessLiveWorkProducer(liveWork, () => harness.sandbox);
    const owner = { runId: 'run-utf8', workspaceId: 'workspace-utf8' };
    const job = processes.start({
      owner,
      idempotencyKey: 'effect-utf8',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: [],
      cwd: 'C:\\workspace'
    });
    const bytes = Buffer.from('你🙂', 'utf8');
    harness.stdoutBytes(bytes.subarray(0, 2));
    harness.stdoutBytes(bytes.subarray(2, 5));
    harness.stdoutBytes(bytes.subarray(5));
    harness.complete();
    await liveWork.wait(owner, job.id, 100);

    const output = liveWork.read(owner, job.id);
    expect(output.chunks.map((chunk) => chunk.text).join('')).toBe('你🙂');
    expect(output.chunks.map((chunk) => chunk.text).join('')).not.toContain('\ufffd');
  });

  it('cancels and joins every producer during Runtime shutdown', async () => {
    const first = processHarness();
    const second = processHarness();
    const harnesses = [first, second];
    const liveWork = new AgentLiveWorkService();
    const processes = new AgentProcessLiveWorkProducer(liveWork, () => harnesses.shift()!.sandbox);
    for (const id of ['one', 'two']) {
      processes.start({
        owner: { runId: 'run-close', workspaceId: 'workspace-close' },
        idempotencyKey: id,
        workspaceRoot: 'C:\\workspace',
        command: 'node.exe',
        args: [id],
        cwd: 'C:\\workspace'
      });
    }

    const closing = liveWork.close();
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    first.complete({ errorCode: 'cancelled' });
    second.complete({ errorCode: 'cancelled' });
    await expect(closing).resolves.toBeUndefined();
  });

  it('publishes terminal completion to the bound sink and drains it before close returns', async () => {
    const harness = processHarness();
    const liveWork = new AgentLiveWorkService();
    const processes = new AgentProcessLiveWorkProducer(liveWork, () => harness.sandbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink = vi.fn(async () => gate);
    const binding = liveWork.bindCompletionSink(sink);
    const job = processes.start({
      owner: { runId: 'run-notification', workspaceId: 'workspace-notification' },
      idempotencyKey: 'notification',
      workspaceRoot: 'C:\\workspace',
      command: 'node.exe',
      args: [],
      cwd: 'C:\\workspace'
    });

    harness.complete({ exitCode: 7 });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-notification',
      workspaceId: 'workspace-notification',
      jobId: job.id,
      workKind: 'process',
      status: 'failed',
      exitCode: 7
    }));
    let closed = false;
    const closing = liveWork.close(1_000).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(liveWork.claimUnreportedCompletions({
      runId: 'run-notification',
      workspaceId: 'workspace-notification'
    })).toEqual([]);
    binding.assertHealthy();
    binding.unbind();
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
    stdoutBytes: (bytes: Buffer) => observer?.onStdout?.(bytes),
    stderr: (text: string) => observer?.onStderr?.(Buffer.from(text)),
    complete: (overrides: Partial<AgentProcessExecutionResult> = {}) => {
      resolveCompletion({ ...baseResult, ...overrides });
    }
  };
}
