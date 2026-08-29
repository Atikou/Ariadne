import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { LiveWorkOutcome, LiveWorkSnapshot } from '@ariadne/live-work';

import type { AgentProcessExecutionResult, AgentProcessSandbox } from '../ports/AgentProcessSandbox.js';
import { AgentLiveWorkService, type AgentLiveWorkOwner } from './AgentLiveWorkService.js';

const MAX_RETAINED_OUTPUT_BYTES = 512 * 1024;

/** Registers sandboxed pipe processes as producers in the Agent live-work authority. */
export class AgentProcessLiveWorkProducer {
  public constructor(
    private readonly liveWork: AgentLiveWorkService,
    private readonly sandboxForWorkspace: ((workspaceRoot: string) => AgentProcessSandbox) | undefined
  ) {}

  public start(input: {
    readonly owner: AgentLiveWorkOwner;
    readonly idempotencyKey: string;
    readonly workspaceRoot: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }): LiveWorkSnapshot {
    const sandboxFactory = this.sandboxForWorkspace;
    if (sandboxFactory === undefined) throw new Error('workspace_process_sandbox_unavailable');
    return this.liveWork.start(input.owner, {
      kind: 'process',
      label: [input.command, ...input.args].join(' ').slice(0, 1_024),
      dedupeKey: input.idempotencyKey,
      preferredId: processJobId(input.owner, input.idempotencyKey),
      metadata: { command: input.command, cwd: input.cwd },
      start: (context) => {
        const sandbox = sandboxFactory(input.workspaceRoot);
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        const lease = sandbox.openFileLease({
          file: input.command,
          args: [...input.args],
          cwd: input.cwd,
          workspaceRoot: input.workspaceRoot,
          mode: sandbox.mode,
          networkMode: 'offline',
          timeoutMs: 24 * 60 * 60_000,
          maxOutputBytes: MAX_RETAINED_OUTPUT_BYTES
        }, {
          onStarted: ({ executionId, pid }) => context.patchMetadata({
            executionId,
            ...(pid === undefined ? {} : { processId: pid })
          }),
          onStdout: (chunk) => context.appendOutput('stdout', stdoutDecoder.write(chunk)),
          onStderr: (chunk) => context.appendOutput('stderr', stderrDecoder.write(chunk))
        });
        context.patchMetadata({ executionId: lease.executionId });
        return {
          done: lease.completion.then((result) => {
            context.appendOutput('stdout', stdoutDecoder.end());
            context.appendOutput('stderr', stderrDecoder.end());
            return processOutcome(result);
          }),
          cancel: () => lease.cancel(),
          write: (text) => lease.writeStdin(text)
        };
      }
    });
  }
}

function processOutcome(result: AgentProcessExecutionResult): LiveWorkOutcome {
  if (result.errorCode === 'cancelled') {
    return {
      status: 'killed',
      detail: result.errorCode,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
    };
  }
  if (result.spawnFailed || (result.exitCode !== undefined && result.exitCode !== 0)) {
    return {
      status: 'failed',
      ...(result.errorCode === undefined ? {} : { detail: result.errorCode }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
    };
  }
  return { status: 'completed', ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }) };
}

function processJobId(owner: AgentLiveWorkOwner, idempotencyKey: string): string {
  const identity = `${owner.runId}\0${owner.workspaceId}\0${idempotencyKey}`;
  return `job_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}
