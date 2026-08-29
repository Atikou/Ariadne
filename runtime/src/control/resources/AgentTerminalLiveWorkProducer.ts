import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { LiveWorkOutcome, LiveWorkSignal, LiveWorkSnapshot } from '@ariadne/live-work';

import type { AgentProcessExecutionResult, AgentProcessLease, AgentProcessSandbox } from '../ports/AgentProcessSandbox.js';
import {
  encodeAgentPtyWorkerFrame,
  parseAgentPtyWorkerEvent,
  type AgentPtyWorkerCommand
} from '../ports/AgentPtyWorkerProtocol.js';
import { AgentLiveWorkService, type AgentLiveWorkOwner } from './AgentLiveWorkService.js';

const MAX_TRANSPORT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs node-pty inside the workspace sandbox process tree. Runtime owns only
 * framed control and live-work state, so a PTY cannot bypass the restricted
 * token, filesystem policy, network policy, or Windows Job used by commands.
 */
export class AgentTerminalLiveWorkProducer {
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
    readonly columns: number;
    readonly rows: number;
  }): LiveWorkSnapshot {
    const sandboxFactory = this.sandboxForWorkspace;
    if (sandboxFactory === undefined) throw new Error('workspace_terminal_sandbox_unavailable');
    return this.liveWork.start(input.owner, {
      kind: 'terminal',
      label: [input.command, ...input.args].join(' ').slice(0, 1_024),
      dedupeKey: input.idempotencyKey,
      preferredId: terminalJobId(input.owner, input.idempotencyKey),
      metadata: {
        command: input.command,
        cwd: input.cwd,
        columns: input.columns,
        rows: input.rows
      },
      start: (context) => {
        const sandbox = sandboxFactory(input.workspaceRoot);
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let stdoutBuffer = '';
        let started = false;
        let terminalOutcome: LiveWorkOutcome | undefined;
        let protocolFailure: string | undefined;
        let terminationRequested = false;
        let lease!: AgentProcessLease;

        const failProtocol = (code: string): void => {
          protocolFailure ??= code;
          lease?.cancel();
        };
        const consume = (text: string): void => {
          stdoutBuffer += text;
          while (true) {
            const newline = stdoutBuffer.indexOf('\n');
            if (newline < 0) {
              if (stdoutBuffer.length > 256 * 1024) failProtocol('agent_pty_transport_frame_too_large');
              return;
            }
            const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line.length === 0) continue;
            try {
              const event = parseAgentPtyWorkerEvent(line);
              if (terminalOutcome !== undefined || protocolFailure !== undefined) {
                throw new Error('agent_pty_transport_event_after_terminal');
              }
              if (event.type === 'started') {
                if (started) throw new Error('agent_pty_transport_duplicate_started');
                started = true;
                context.patchMetadata({ processId: event.processId });
              } else if (event.type === 'output') {
                if (!started) throw new Error('agent_pty_transport_output_before_started');
                context.appendOutput('terminal', Buffer.from(event.dataBase64, 'base64').toString('utf8'));
              } else if (event.type === 'exit') {
                if (!started) throw new Error('agent_pty_transport_exit_before_started');
                if (event.signal !== undefined) context.patchMetadata({ signal: event.signal });
                terminalOutcome = terminationRequested
                  ? { status: 'killed', exitCode: event.exitCode }
                  : event.exitCode === 0
                    ? { status: 'completed', exitCode: event.exitCode }
                    : { status: 'failed', exitCode: event.exitCode, detail: `terminal_exit_${event.exitCode}` };
              } else {
                protocolFailure = `${event.code}:${event.message}`.slice(0, 4_096);
              }
            } catch (error) {
              failProtocol(error instanceof Error ? error.message : String(error));
            }
          }
        };

        lease = sandbox.openFileLease({
          file: process.execPath,
          args: [resolvePtyWorkerPath()],
          cwd: input.cwd,
          workspaceRoot: input.workspaceRoot,
          mode: sandbox.mode,
          networkMode: 'offline',
          timeoutMs: 24 * 60 * 60_000,
          maxOutputBytes: MAX_TRANSPORT_OUTPUT_BYTES
        }, {
          onStarted: ({ executionId, pid }) => context.patchMetadata({
            executionId,
            ...(pid === undefined ? {} : { workerProcessId: pid })
          }),
          onStdout: (chunk) => consume(stdoutDecoder.write(chunk)),
          onStderr: (chunk) => context.appendOutput('system', stderrDecoder.write(chunk))
        });
        context.patchMetadata({ executionId: lease.executionId });

        let writes = Promise.resolve();
        const send = (frame: AgentPtyWorkerCommand): Promise<void> => {
          const operation = writes.then(() => lease.writeStdin(encodeAgentPtyWorkerFrame(frame)));
          writes = operation.catch(() => undefined);
          return operation;
        };
        const startFrame = send({
          type: 'start',
          command: input.command,
          args: [...input.args],
          cwd: input.cwd,
          columns: input.columns,
          rows: input.rows
        }).catch((error) => {
          failProtocol(error instanceof Error ? error.message : String(error));
        });

        return {
          done: Promise.all([startFrame, lease.completion]).then(([, result]) => {
            consume(stdoutDecoder.end());
            context.appendOutput('system', stderrDecoder.end());
            if (stdoutBuffer.trim().length > 0) {
              protocolFailure ??= 'agent_pty_transport_incomplete_frame';
            }
            return terminalOutcome ?? terminalTransportOutcome(result, protocolFailure, terminationRequested);
          }),
          cancel: () => {
            terminationRequested = true;
            lease.cancel();
          },
          write: (text) => send({
            type: 'write',
            dataBase64: Buffer.from(text, 'utf8').toString('base64')
          }),
          resize: (size) => send({ type: 'resize', ...size }),
          signal: (signal) => {
            if (signal !== 'interrupt') terminationRequested = true;
            return signal === 'interrupt'
              ? send({ type: 'signal', signal })
              : lease.signal(signal);
          }
        };
      }
    });
  }
}

function terminalTransportOutcome(
  result: AgentProcessExecutionResult,
  protocolFailure: string | undefined,
  terminationRequested: boolean
): LiveWorkOutcome {
  if (terminationRequested || result.errorCode === 'cancelled') {
    return {
      status: 'killed',
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(protocolFailure === undefined ? {} : { detail: protocolFailure })
    };
  }
  const detail = protocolFailure
    ?? result.errorCode
    ?? (result.truncated ? 'agent_pty_transport_output_limit' : 'agent_pty_transport_ended_without_exit');
  return {
    status: 'failed',
    detail,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
  };
}

function terminalJobId(owner: AgentLiveWorkOwner, idempotencyKey: string): string {
  const identity = `${owner.runId}\0${owner.workspaceId}\0terminal\0${idempotencyKey}`;
  return `job_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function resolvePtyWorkerPath(): string {
  const installed = fileURLToPath(new URL('../../workers/AgentPtyWorker.js', import.meta.url));
  if (existsSync(installed)) return installed;
  const sourceTestBuild = fileURLToPath(new URL('../../../dist/workers/AgentPtyWorker.js', import.meta.url));
  if (existsSync(sourceTestBuild)) return sourceTestBuild;
  throw new Error('agent_pty_worker_missing');
}
