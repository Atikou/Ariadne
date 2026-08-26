import type {
  Transport,
  TransportSendOptions
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import type { AgentHostCapabilityClient } from '../../control/ports/AgentHostCapability.js';

type RemoteServer = Extract<
  RuntimePolicySnapshot['mcp']['servers'][number],
  { transport: 'streamable-http' }
>;

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const RECEIVE_WAIT_MS = 20_000;

/** Main-owned HTTP/OAuth transport for the production v3 MCP adapter. */
export class AgentHostMcpTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private connectionId?: string;
  private started = false;
  private closed = false;

  public constructor(
    private readonly config: RemoteServer,
    private readonly host: AgentHostCapabilityClient
  ) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error('mcp_remote_transport_already_started');
    this.started = true;
    const result = await this.host.request({
      kind: 'mcp.remote.connect',
      serverId: this.config.id,
      endpoint: this.config.endpoint,
      ...(this.config.credentialRef ? { credentialRef: this.config.credentialRef } : {})
    }, AUTHORIZATION_TIMEOUT_MS);
    if (typeof result.connectionId !== 'string') {
      throw new Error('mcp_remote_connection_id_missing');
    }
    this.connectionId = result.connectionId;
    void this.receive();
  }

  public async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await this.host.request({
      kind: 'mcp.remote.send',
      connectionId: this.requireConnection(),
      message
    }, this.config.credentialRef ? AUTHORIZATION_TIMEOUT_MS : undefined);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connectionId = this.connectionId;
    this.connectionId = undefined;
    if (connectionId) {
      await this.host.request({ kind: 'mcp.remote.close', connectionId })
        .catch(() => undefined);
    }
    this.onclose?.();
  }

  private async receive(): Promise<void> {
    try {
      while (!this.closed) {
        const result = await this.host.request({
          kind: 'mcp.remote.receive',
          connectionId: this.requireConnection(),
          maxWaitMs: RECEIVE_WAIT_MS
        }, RECEIVE_WAIT_MS + 5_000);
        if (!Array.isArray(result.messages)) {
          throw new Error('mcp_remote_receive_messages_invalid');
        }
        for (const message of result.messages) {
          if (!isJsonRpcMessage(message)) {
            throw new Error('mcp_remote_receive_message_invalid');
          }
          this.onmessage?.(message);
        }
        if (typeof result.error === 'string') this.onerror?.(new Error(result.error));
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
      throw new Error('mcp_remote_transport_not_open');
    }
    return this.connectionId;
  }
}

function isJsonRpcMessage(value: unknown): value is JSONRPCMessage {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
