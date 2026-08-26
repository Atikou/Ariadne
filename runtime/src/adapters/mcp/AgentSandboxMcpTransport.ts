import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {
  Transport,
  TransportSendOptions
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import type { AgentProcessSandbox } from '../../control/ports/AgentProcessSandbox.js';

type StdioServer = Extract<
  RuntimePolicySnapshot['mcp']['servers'][number],
  { transport: 'stdio' }
>;
const MAX_STDIN_CHUNK_BYTES = 64 * 1024;

/** Official MCP stdio framing over an injected authenticated process lease. */
export class AgentSandboxMcpTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private lease?: ReturnType<AgentProcessSandbox['openFileLease']>;
  private started = false;
  private closed = false;

  public constructor(
    private readonly config: StdioServer,
    private readonly workspaceRoot: string,
    private readonly sandbox: AgentProcessSandbox
  ) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error('mcp_stdio_transport_already_started');
    this.started = true;
    this.lease = this.sandbox.openFileLease({
      file: this.config.command,
      args: [...this.config.args],
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      mode: this.config.workspaceAccess === 'write' ? 'workspace-write' : 'read-only',
      networkMode: this.config.networkAccess,
      timeoutMs: 24 * 60 * 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
      environment: allowedEnvironment(this.config.environmentAllowlist)
    }, {
      onStdout: (chunk) => this.consumeStdout(chunk),
      onStderr: (chunk) => {
        if (chunk.byteLength > 0) this.onerror?.(new Error('mcp_stdio_server_stderr'));
      }
    });
    void this.lease.completion.then((result) => {
      if (result.spawnFailed || result.timedOut || result.errorCode || result.exitCode !== 0) {
        this.onerror?.(new Error(
          `mcp_stdio_server_exit:${result.errorCode ?? result.exitCode ?? 'unknown'}`
        ));
      }
      this.finishClose();
    }, (error: unknown) => {
      this.onerror?.(asError(error));
      this.finishClose();
    });
  }

  public async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const lease = this.requireLease();
    const bytes = Buffer.from(serializeMessage(message), 'utf8');
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_STDIN_CHUNK_BYTES) {
      await lease.writeStdin(bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + MAX_STDIN_CHUNK_BYTES)
      ));
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.lease?.cancel();
    this.finishClose();
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.readBuffer.append(chunk);
      while (true) {
        const message = this.readBuffer.readMessage();
        if (!message) return;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(asError(error));
      this.lease?.cancel();
    }
  }

  private requireLease(): NonNullable<typeof this.lease> {
    if (!this.started || !this.lease || this.closed) {
      throw new Error('mcp_stdio_transport_not_open');
    }
    return this.lease;
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.onclose?.();
  }
}

function allowedEnvironment(names: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
