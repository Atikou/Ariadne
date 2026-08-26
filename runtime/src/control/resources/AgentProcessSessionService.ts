import { createHash } from 'node:crypto';

import type {
  AgentProcessExecutionResult,
  AgentProcessLease,
  AgentProcessSandbox
} from '../ports/AgentProcessSandbox.js';

const MAX_RETAINED_OUTPUT_BYTES = 512 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_OWNER_SESSIONS = 8;

export type AgentProcessSessionStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentProcessSessionOwner {
  readonly runId: string;
  readonly workspaceId: string;
}

export interface AgentProcessSessionSnapshot {
  readonly resourceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly status: AgentProcessSessionStatus;
  readonly executionId: string;
  readonly pid?: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly outputCursor: number;
  readonly retainedFromCursor: number;
}

export interface AgentProcessSessionOutput {
  readonly resourceId: string;
  readonly status: AgentProcessSessionStatus;
  readonly chunks: readonly {
    readonly cursor: number;
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
  }[];
  readonly nextCursor: number;
  readonly truncatedBeforeCursor: boolean;
}

interface OutputChunk {
  cursor: number;
  byteLength: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

interface LiveSession {
  readonly owner: AgentProcessSessionOwner;
  readonly idempotencyKey: string;
  readonly lease: AgentProcessLease;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly resourceId: string;
  readonly startedAt: string;
  status: AgentProcessSessionStatus;
  pid?: number;
  endedAt?: string;
  exitCode?: number;
  errorCode?: string;
  outputCursor: number;
  retainedBytes: number;
  output: OutputChunk[];
  stopRequested: boolean;
  inputActive: boolean;
}

/**
 * Runtime-owned registry for process resources that outlive an individual Tool
 * Effect. Every operation is fenced by the exact Agent Run and workspace.
 * Process state is intentionally live-only; shutdown cancels and joins all
 * leases instead of pretending that an OS process can be restored.
 */
export class AgentProcessSessionService {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly idempotencyIndex = new Map<string, string>();
  private closing = false;
  private closePromise?: Promise<void>;

  public constructor(
    private readonly sandboxForWorkspace: ((workspaceRoot: string) => AgentProcessSandbox) | undefined
  ) {}

  public start(input: {
    readonly owner: AgentProcessSessionOwner;
    readonly idempotencyKey: string;
    readonly workspaceRoot: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }): AgentProcessSessionSnapshot {
    if (this.closing) throw new Error('process_session_service_closing');
    const sandboxFactory = this.sandboxForWorkspace;
    if (sandboxFactory === undefined) throw new Error('workspace_process_sandbox_unavailable');
    const idempotencyIndexKey = ownerKey(input.owner, input.idempotencyKey);
    const existingId = this.idempotencyIndex.get(idempotencyIndexKey);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing !== undefined) return snapshot(existing);
    }
    if (this.list(input.owner).filter(
      (candidate) => candidate.status === 'running' || candidate.status === 'stopping'
    ).length >= MAX_OWNER_SESSIONS) {
      throw new Error('process_session_owner_limit_reached');
    }

    const resourceId = resourceIdFor(input.owner, input.idempotencyKey);
    const sandbox = sandboxFactory(input.workspaceRoot);
    let session: LiveSession | undefined;
    let startedPid: number | undefined;
    const pendingOutput: { stream: OutputChunk['stream']; bytes: Buffer }[] = [];
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
      onStarted: ({ pid }) => {
        startedPid = pid;
        if (session !== undefined && pid !== undefined) session.pid = pid;
      },
      onStdout: (chunk) => {
        if (session !== undefined) appendOutput(session, 'stdout', chunk);
        else pendingOutput.push({ stream: 'stdout', bytes: Buffer.from(chunk) });
      },
      onStderr: (chunk) => {
        if (session !== undefined) appendOutput(session, 'stderr', chunk);
        else pendingOutput.push({ stream: 'stderr', bytes: Buffer.from(chunk) });
      }
    });
    session = {
      owner: { ...input.owner },
      idempotencyKey: input.idempotencyKey,
      lease,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      resourceId,
      startedAt: new Date().toISOString(),
      status: 'running',
      outputCursor: 0,
      retainedBytes: 0,
      output: [],
      stopRequested: false,
      inputActive: false
    };
    if (startedPid !== undefined) session.pid = startedPid;
    for (const output of pendingOutput) appendOutput(session, output.stream, output.bytes);
    this.sessions.set(resourceId, session);
    this.idempotencyIndex.set(idempotencyIndexKey, resourceId);
    void lease.completion.then((result) => this.settle(session!, result));
    return snapshot(session);
  }

  public list(owner: AgentProcessSessionOwner): readonly AgentProcessSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((session) => sameOwner(session.owner, owner))
      .map(snapshot);
  }

  public read(
    owner: AgentProcessSessionOwner,
    resourceId: string,
    cursor = 0,
    maxBytes = MAX_READ_BYTES
  ): AgentProcessSessionOutput {
    const session = this.requireOwned(owner, resourceId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('process_session_cursor_invalid');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
      throw new Error('process_session_read_limit_invalid');
    }
    const retainedFromCursor = session.output[0]?.cursor ?? session.outputCursor;
    let remaining = maxBytes;
    const chunks: AgentProcessSessionOutput['chunks'][number][] = [];
    for (const chunk of session.output) {
      const end = chunk.cursor + chunk.byteLength;
      if (end <= cursor || remaining === 0) continue;
      const bytes = Buffer.from(chunk.text, 'utf8');
      const offset = Math.max(0, cursor - chunk.cursor);
      const selected = bytes.subarray(offset, offset + remaining);
      if (selected.byteLength === 0) continue;
      chunks.push({
        cursor: chunk.cursor + offset,
        stream: chunk.stream,
        text: selected.toString('utf8')
      });
      remaining -= selected.byteLength;
    }
    const nextCursor = chunks.length === 0
      ? Math.max(cursor, retainedFromCursor)
      : chunks[chunks.length - 1]!.cursor
        + Buffer.byteLength(chunks[chunks.length - 1]!.text, 'utf8');
    return {
      resourceId,
      status: session.status,
      chunks,
      nextCursor,
      truncatedBeforeCursor: cursor < retainedFromCursor
    };
  }

  public async write(
    owner: AgentProcessSessionOwner,
    resourceId: string,
    text: string,
    submit: boolean
  ): Promise<AgentProcessSessionSnapshot> {
    const session = this.requireOwned(owner, resourceId);
    if (session.status !== 'running') throw new Error('process_session_not_running');
    if (session.inputActive) throw new Error('process_session_input_active');
    session.inputActive = true;
    try {
      await session.lease.writeStdin(submit ? `${text}\n` : text);
      return snapshot(session);
    } finally {
      session.inputActive = false;
    }
  }

  public async stop(
    owner: AgentProcessSessionOwner,
    resourceId: string
  ): Promise<AgentProcessSessionSnapshot> {
    const session = this.requireOwned(owner, resourceId);
    if (session.status === 'stopping') return snapshot(session);
    if (session.status !== 'running') return snapshot(session);
    session.stopRequested = true;
    session.status = 'stopping';
    session.lease.cancel();
    await settleWithin(session.lease.completion, 5_000);
    return snapshot(session);
  }

  public close(timeoutMs = 5_000): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeLiveSessions(timeoutMs);
    return this.closePromise;
  }

  public async closeOwner(runId: string, timeoutMs = 5_000): Promise<void> {
    const live = [...this.sessions.values()].filter(
      (session) => session.owner.runId === runId
        && (session.status === 'running' || session.status === 'stopping')
    );
    for (const session of live) {
      session.stopRequested = true;
      session.status = 'stopping';
      session.lease.cancel();
    }
    await settleWithin(Promise.allSettled(
      live.map((session) => session.lease.completion)
    ), timeoutMs);
  }

  private async closeLiveSessions(timeoutMs: number): Promise<void> {
    const live = [...this.sessions.values()].filter(
      (session) => session.status === 'running' || session.status === 'stopping'
    );
    for (const session of live) {
      session.stopRequested = true;
      session.status = 'stopping';
      session.lease.cancel();
    }
    await settleWithin(Promise.allSettled(
      live.map((session) => session.lease.completion)
    ), timeoutMs);
  }

  private requireOwned(owner: AgentProcessSessionOwner, resourceId: string): LiveSession {
    const session = this.sessions.get(resourceId);
    if (session === undefined || !sameOwner(session.owner, owner)) {
      throw new Error('process_session_not_found');
    }
    return session;
  }

  private settle(session: LiveSession, result: AgentProcessExecutionResult): void {
    if (session.status !== 'running' && session.status !== 'stopping') return;
    session.endedAt = new Date().toISOString();
    if (result.exitCode !== undefined) session.exitCode = result.exitCode;
    if (result.errorCode !== undefined) session.errorCode = result.errorCode;
    session.status = session.stopRequested || result.errorCode === 'cancelled'
      ? 'stopped'
      : result.spawnFailed || (result.exitCode !== undefined && result.exitCode !== 0)
        ? 'failed'
        : 'completed';
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function appendOutput(session: LiveSession, stream: OutputChunk['stream'], bytes: Buffer): void {
  if (bytes.byteLength === 0) return;
  const chunk: OutputChunk = {
    cursor: session.outputCursor,
    byteLength: bytes.byteLength,
    stream,
    text: bytes.toString('utf8')
  };
  session.outputCursor += bytes.byteLength;
  session.retainedBytes += bytes.byteLength;
  session.output.push(chunk);
  while (session.retainedBytes > MAX_RETAINED_OUTPUT_BYTES && session.output.length > 1) {
    const removed = session.output.shift()!;
    session.retainedBytes -= removed.byteLength;
  }
}

function snapshot(session: LiveSession): AgentProcessSessionSnapshot {
  return {
    resourceId: session.resourceId,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    status: session.status,
    executionId: session.lease.executionId,
    ...(session.pid === undefined ? {} : { pid: session.pid }),
    startedAt: session.startedAt,
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.errorCode === undefined ? {} : { errorCode: session.errorCode }),
    outputCursor: session.outputCursor,
    retainedFromCursor: session.output[0]?.cursor ?? session.outputCursor
  };
}

function ownerKey(owner: AgentProcessSessionOwner, idempotencyKey: string): string {
  return `${owner.runId}\0${owner.workspaceId}\0${idempotencyKey}`;
}

function resourceIdFor(owner: AgentProcessSessionOwner, idempotencyKey: string): string {
  return `process_${createHash('sha256').update(ownerKey(owner, idempotencyKey)).digest('hex').slice(0, 24)}`;
}

function sameOwner(left: AgentProcessSessionOwner, right: AgentProcessSessionOwner): boolean {
  return left.runId === right.runId && left.workspaceId === right.workspaceId;
}
