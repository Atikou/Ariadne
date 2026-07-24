import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerConfig } from "../config/types.js";
import type { HostCapabilityBroker } from "../host/HostCapabilityBroker.js";

type RemoteMcpServerConfig = Extract<McpServerConfig, { transport: "streamable-http" }>;

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const RECEIVE_WAIT_MS = 20_000;

/**
 * Runtime-side half of the remote MCP transport. Main owns the official HTTP
 * transport and OAuth credentials; only JSON-RPC messages and opaque
 * connection identifiers cross Node IPC.
 */
export class HostMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private connectionId?: string;
  private started = false;
  private closed = false;
  private receiveLoop?: Promise<void>;

  constructor(
    private readonly config: RemoteMcpServerConfig,
    private readonly broker: HostCapabilityBroker,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("mcp_remote_transport_already_started");
    this.started = true;
    const result = await this.broker.request({
      kind: "mcp.remote.connect",
      serverId: this.config.id,
      endpoint: this.config.endpoint,
      ...(this.config.credentialRef ? { credentialRef: this.config.credentialRef } : {}),
    }, AUTHORIZATION_TIMEOUT_MS);
    const connectionId = result.connectionId;
    if (typeof connectionId !== "string") throw new Error("mcp_remote_connection_id_missing");
    this.connectionId = connectionId;
    this.receiveLoop = this.receive();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const connectionId = this.requireConnection();
    await this.broker.request({
      kind: "mcp.remote.send",
      connectionId,
      message,
    }, this.config.credentialRef ? AUTHORIZATION_TIMEOUT_MS : undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connectionId = this.connectionId;
    this.connectionId = undefined;
    if (connectionId) {
      await this.broker.request({
        kind: "mcp.remote.close",
        connectionId,
      }).catch(() => undefined);
    }
    this.onclose?.();
  }

  private async receive(): Promise<void> {
    try {
      while (!this.closed) {
        const connectionId = this.requireConnection();
        const result = await this.broker.request({
          kind: "mcp.remote.receive",
          connectionId,
          maxWaitMs: RECEIVE_WAIT_MS,
        }, RECEIVE_WAIT_MS + 5_000);
        const messages = result.messages;
        if (!Array.isArray(messages)) throw new Error("mcp_remote_receive_messages_invalid");
        for (const message of messages) {
          if (!isJsonRpcMessage(message)) {
            throw new Error("mcp_remote_receive_message_invalid");
          }
          this.onmessage?.(message);
        }
        const reason = typeof result.error === "string" ? result.error : undefined;
        if (reason) this.onerror?.(new Error(reason));
        if (result.closed === true) {
          await this.close();
          return;
        }
      }
    } catch (error) {
      if (this.closed) return;
      this.onerror?.(asError(error));
      await this.close();
    }
  }

  private requireConnection(): string {
    if (!this.started || !this.connectionId || this.closed) {
      throw new Error("mcp_remote_transport_not_open");
    }
    return this.connectionId;
  }
}

function isJsonRpcMessage(value: unknown): value is JSONRPCMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
