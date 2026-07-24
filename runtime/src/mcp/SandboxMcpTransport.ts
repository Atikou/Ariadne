import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerConfig } from "../config/types.js";
import {
  requireInteractiveProcessSandbox,
  type ProcessSandbox,
  type SandboxProcessLease,
} from "../sandbox/ProcessSandbox.js";
import { SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES } from "../sandbox/SandboxContracts.js";

type StdioMcpServerConfig = Extract<McpServerConfig, { transport: "stdio" }>;

/**
 * MCP stdio transport backed by the same authenticated process lease used by
 * other Runtime tools. It never asks the official SDK to spawn a host process.
 */
export class SandboxMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly readBuffer = new ReadBuffer();
  private lease?: SandboxProcessLease;
  private started = false;
  private closed = false;

  constructor(
    private readonly config: StdioMcpServerConfig,
    private readonly workspaceRoot: string,
    private readonly processSandbox: ProcessSandbox,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("mcp_stdio_transport_already_started");
    this.started = true;
    const sandbox = requireInteractiveProcessSandbox(this.processSandbox);
    this.lease = sandbox.openFileLease({
      file: this.config.command,
      args: this.config.args,
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      mode: this.config.workspaceAccess === "write" ? "workspace-write" : "read-only",
      networkMode: this.config.networkAccess,
      timeoutMs: 24 * 60 * 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
      environment: allowedEnvironment(this.config.environmentAllowlist),
    }, {
      onStdout: (chunk) => this.consumeStdout(chunk),
      onStderr: (chunk) => {
        if (chunk.byteLength > 0) this.onerror?.(new Error("mcp_stdio_server_stderr"));
      },
    });
    void this.lease.completion.then(
      (result) => {
        if (result.spawnFailed || result.timedOut || result.errorCode || result.exitCode !== 0) {
          this.onerror?.(new Error(`mcp_stdio_server_exit:${result.errorCode ?? result.exitCode ?? "unknown"}`));
        }
        this.finishClose();
      },
      (error: unknown) => {
        this.onerror?.(asError(error));
        this.finishClose();
      },
    );
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const lease = this.requireLease();
    const bytes = Buffer.from(serializeMessage(message), "utf8");
    for (let offset = 0; offset < bytes.byteLength; offset += SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES) {
      await lease.writeStdin(bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES),
      ));
    }
  }

  async close(): Promise<void> {
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

  private requireLease(): SandboxProcessLease {
    if (!this.started || !this.lease || this.closed) {
      throw new Error("mcp_stdio_transport_not_open");
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
