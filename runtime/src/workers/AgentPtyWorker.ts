import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import { spawn, type IPty } from 'node-pty';

import {
  encodeAgentPtyWorkerFrame,
  parseAgentPtyWorkerCommand,
  type AgentPtyWorkerEvent
} from '../control/ports/AgentPtyWorkerProtocol.js';

let terminal: IPty | undefined;
let started = false;
let finished = false;
let inputBuffer = '';
const decoder = new StringDecoder('utf8');

process.stdin.on('data', (chunk: Buffer) => {
  if (finished) return;
  inputBuffer += decoder.write(chunk);
  consumeInput();
});
process.stdin.on('end', () => {
  inputBuffer += decoder.end();
  consumeInput();
  if (!finished) fail('agent_pty_worker_input_closed', 'PTY worker input closed before the terminal exited.');
});
process.stdin.on('error', (error) => fail('agent_pty_worker_input_failed', error.message));
process.on('uncaughtException', (error) => fail('agent_pty_worker_uncaught', error.message));
process.on('unhandledRejection', (error) => fail(
  'agent_pty_worker_rejection',
  error instanceof Error ? error.message : String(error)
));

function consumeInput(): void {
  while (!finished) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) {
      if (inputBuffer.length > 256 * 1024) fail('agent_pty_worker_frame_too_large', 'PTY worker input frame exceeded its limit.');
      return;
    }
    const line = inputBuffer.slice(0, newline).replace(/\r$/u, '');
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.length === 0) continue;
    try {
      handle(parseAgentPtyWorkerCommand(line));
    } catch (error) {
      fail('agent_pty_worker_protocol_failed', error instanceof Error ? error.message : String(error));
    }
  }
}

function handle(command: ReturnType<typeof parseAgentPtyWorkerCommand>): void {
  if (command.type === 'start') {
    if (started) throw new Error('agent_pty_worker_already_started');
    started = true;
    terminal = spawn(command.command, [...command.args], {
      name: 'xterm-256color',
      cols: command.columns,
      rows: command.rows,
      cwd: command.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      },
      useConpty: process.platform === 'win32',
      useConptyDll: process.platform === 'win32'
    });
    emit({ type: 'started', processId: terminal.pid });
    terminal.onData((data) => emit({
      type: 'output',
      dataBase64: Buffer.from(data, 'utf8').toString('base64')
    }));
    terminal.onExit(({ exitCode, signal }) => finish({
      type: 'exit',
      exitCode,
      ...(signal === undefined ? {} : { signal })
    }));
    return;
  }
  if (!started || terminal === undefined) throw new Error('agent_pty_worker_not_started');
  if (command.type === 'write') {
    terminal.write(Buffer.from(command.dataBase64, 'base64').toString('utf8'));
  } else if (command.type === 'resize') {
    terminal.resize(command.columns, command.rows);
  } else if (command.signal === 'interrupt') {
    terminal.write('\x03');
  } else {
    safelyKill();
  }
}

function emit(event: AgentPtyWorkerEvent): void {
  if (finished) return;
  process.stdout.write(encodeAgentPtyWorkerFrame(event));
}

function finish(event: AgentPtyWorkerEvent, workerExitCode = 0): void {
  if (finished) return;
  process.stdout.write(encodeAgentPtyWorkerFrame(event), () => process.exit(workerExitCode));
  finished = true;
}

function fail(code: string, message: string): void {
  if (finished) return;
  safelyKill();
  finish({ type: 'error', code, message: message.slice(0, 4_096) }, 1);
}

function safelyKill(): void {
  try {
    terminal?.kill();
  } catch {
    // The PTY may already be exiting.
  }
}
