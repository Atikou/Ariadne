/** Framed contract between Agent control and its sandbox-hosted PTY adapter. */
const MAX_FRAME_CHARACTERS = 256 * 1024;

export type AgentPtyWorkerCommand =
  | {
      readonly type: 'start';
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: 'write'; readonly dataBase64: string }
  | { readonly type: 'resize'; readonly columns: number; readonly rows: number }
  | { readonly type: 'signal'; readonly signal: 'interrupt' | 'terminate' | 'kill' };

export type AgentPtyWorkerEvent =
  | { readonly type: 'started'; readonly processId: number }
  | { readonly type: 'output'; readonly dataBase64: string }
  | { readonly type: 'exit'; readonly exitCode: number; readonly signal?: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

export function encodeAgentPtyWorkerFrame(
  frame: AgentPtyWorkerCommand | AgentPtyWorkerEvent
): string {
  const encoded = JSON.stringify(frame);
  if (encoded.length > MAX_FRAME_CHARACTERS) throw new Error('agent_pty_worker_frame_too_large');
  return `${encoded}\n`;
}

export function parseAgentPtyWorkerCommand(line: string): AgentPtyWorkerCommand {
  const value = parseFrame(line);
  if (value.type === 'start') {
    exactKeys(value, ['type', 'command', 'args', 'cwd', 'columns', 'rows']);
    if (!nonEmpty(value.command) || !nonEmpty(value.cwd) || !stringArray(value.args)
      || !terminalDimension(value.columns) || !terminalDimension(value.rows)) {
      throw new Error('agent_pty_worker_start_invalid');
    }
    return {
      type: 'start',
      command: value.command,
      args: [...value.args],
      cwd: value.cwd,
      columns: value.columns,
      rows: value.rows
    };
  }
  if (value.type === 'write') {
    exactKeys(value, ['type', 'dataBase64']);
    if (!canonicalBase64(value.dataBase64)) throw new Error('agent_pty_worker_write_invalid');
    return { type: 'write', dataBase64: value.dataBase64 };
  }
  if (value.type === 'resize') {
    exactKeys(value, ['type', 'columns', 'rows']);
    if (!terminalDimension(value.columns) || !terminalDimension(value.rows)) {
      throw new Error('agent_pty_worker_resize_invalid');
    }
    return { type: 'resize', columns: value.columns, rows: value.rows };
  }
  if (value.type === 'signal') {
    exactKeys(value, ['type', 'signal']);
    if (value.signal !== 'interrupt' && value.signal !== 'terminate' && value.signal !== 'kill') {
      throw new Error('agent_pty_worker_signal_invalid');
    }
    return { type: 'signal', signal: value.signal };
  }
  throw new Error('agent_pty_worker_command_unknown');
}

export function parseAgentPtyWorkerEvent(line: string): AgentPtyWorkerEvent {
  const value = parseFrame(line);
  if (value.type === 'started') {
    exactKeys(value, ['type', 'processId']);
    if (!positiveInteger(value.processId)) throw new Error('agent_pty_worker_started_invalid');
    return { type: 'started', processId: value.processId };
  }
  if (value.type === 'output') {
    exactKeys(value, ['type', 'dataBase64']);
    if (!canonicalBase64(value.dataBase64)) throw new Error('agent_pty_worker_output_invalid');
    return { type: 'output', dataBase64: value.dataBase64 };
  }
  if (value.type === 'exit') {
    exactKeys(value, ['type', 'exitCode', 'signal']);
    if (!safeInteger(value.exitCode)
      || (value.signal !== undefined && !safeInteger(value.signal))) {
      throw new Error('agent_pty_worker_exit_invalid');
    }
    return {
      type: 'exit',
      exitCode: value.exitCode,
      ...(value.signal === undefined ? {} : { signal: value.signal })
    };
  }
  if (value.type === 'error') {
    exactKeys(value, ['type', 'code', 'message']);
    if (!nonEmpty(value.code) || typeof value.message !== 'string') {
      throw new Error('agent_pty_worker_error_invalid');
    }
    return { type: 'error', code: value.code, message: value.message.slice(0, 4_096) };
  }
  throw new Error('agent_pty_worker_event_unknown');
}

function parseFrame(line: string): Record<string, unknown> {
  if (line.length === 0 || line.length > MAX_FRAME_CHARACTERS) {
    throw new Error('agent_pty_worker_frame_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('agent_pty_worker_frame_not_json');
  }
  if (!record(value) || typeof value.type !== 'string') {
    throw new Error('agent_pty_worker_frame_invalid');
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new Error('agent_pty_worker_frame_unknown_field');
  }
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_FRAME_CHARACTERS) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128
    && value.every((item) => typeof item === 'string' && item.length <= 8_192);
}

function terminalDimension(value: unknown): value is number {
  return positiveInteger(value) && value <= 1_000;
}

function positiveInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
