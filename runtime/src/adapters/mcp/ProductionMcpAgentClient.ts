import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type { AgentHostCapabilityClient } from '../../control/ports/AgentHostCapability.js';
import type { AgentProcessSandbox } from '../../control/ports/AgentProcessSandbox.js';
import { AgentHostMcpTransport } from './AgentHostMcpTransport.js';
import { AgentSandboxMcpTransport } from './AgentSandboxMcpTransport.js';

const MAX_MCP_RESULT_BYTES = 256 * 1024;
const MAX_MCP_TOOLS = 256;
type McpServer = RuntimePolicySnapshot['mcp']['servers'][number];

export interface McpAgentConnection {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
    }>;
  }>;
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, AgentToolJsonValue>>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpAgentConnectionFactory = (
  server: McpServer,
  host: AgentHostCapabilityClient,
  signal: AbortSignal,
  workspaceRoot: string,
  processSandboxFactory?: (workspaceRoot: string) => AgentProcessSandbox
) => Promise<McpAgentConnection>;

export interface McpAgentWorkspace {
  readonly rootPath: string;
  readonly access: 'read' | 'write';
}

/** Bounded one-operation MCP client used by the immutable v3 Tool Catalog. */
export class ProductionMcpAgentClient {
  private readonly servers: ReadonlyMap<string, McpServer>;
  private readonly connectionFactory: McpAgentConnectionFactory;

  public constructor(
    servers: readonly McpServer[],
    private readonly host: AgentHostCapabilityClient,
    connectionFactory?: McpAgentConnectionFactory,
    private readonly processSandboxFactory?: (workspaceRoot: string) => AgentProcessSandbox
  ) {
    this.servers = new Map(servers.map((server) => [server.id, structuredClone(server)]));
    this.connectionFactory = connectionFactory ?? createConnection;
  }

  public listServerIds(workspace: McpAgentWorkspace): readonly string[] {
    return [...this.servers.values()]
      .filter((server) => isServerAvailable(server, workspace, this.processSandboxFactory))
      .map((server) => server.id)
      .sort(compareCodeUnits);
  }

  public listTools(
    serverId: string,
    signal: AbortSignal,
    workspace: McpAgentWorkspace
  ): Promise<AgentToolJsonValue> {
    return this.withClient(serverId, signal, workspace, async (client) => {
      const result = await client.listTools();
      const tools = result.tools.slice(0, MAX_MCP_TOOLS).map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema as AgentToolJsonValue,
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: tool.outputSchema as AgentToolJsonValue }),
        ...(tool.annotations === undefined
          ? {}
          : { annotations: tool.annotations as AgentToolJsonValue })
      }));
      return boundedJson({
        serverId,
        tools,
        truncated: result.tools.length > tools.length
      });
    });
  }

  public callTool(
    serverId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, AgentToolJsonValue>>,
    signal: AbortSignal,
    workspace: McpAgentWorkspace
  ): Promise<AgentToolJsonValue> {
    return this.withClient(serverId, signal, workspace, async (client) => boundedJson(
      await client.callTool({
        name: toolName,
        arguments: structuredClone(argumentsValue)
      })
    ));
  }

  private async withClient(
    serverId: string,
    signal: AbortSignal,
    workspace: McpAgentWorkspace,
    operation: (client: McpAgentConnection) => Promise<AgentToolJsonValue>
  ): Promise<AgentToolJsonValue> {
    signal.throwIfAborted();
    const server = this.servers.get(serverId);
    if (
      server === undefined
      || !isServerAvailable(server, workspace, this.processSandboxFactory)
    ) throw new Error('mcp_server_not_enabled_for_workspace');
    const client = await this.connectionFactory(
      server,
      this.host,
      signal,
      workspace.rootPath,
      this.processSandboxFactory
    );
    const abort = (): void => { void client.close().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await operation(client);
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
      await client.close().catch(() => undefined);
    }
  }
}

async function createConnection(
  server: McpServer,
  host: AgentHostCapabilityClient,
  signal: AbortSignal,
  workspaceRoot: string,
  processSandboxFactory?: (workspaceRoot: string) => AgentProcessSandbox
): Promise<McpAgentConnection> {
  signal.throwIfAborted();
  const client = new Client(
    { name: 'Ariadne Agent', version: '3.0' },
    { capabilities: {} }
  );
  const transport = server.transport === 'streamable-http'
    ? new AgentHostMcpTransport(server, host)
    : new AgentSandboxMcpTransport(
        server,
        workspaceRoot,
        requireProcessSandboxFactory(processSandboxFactory, workspaceRoot)
      );
  await client.connect(transport);
  return client as McpAgentConnection;
}

function isServerAvailable(
  server: McpServer,
  workspace: McpAgentWorkspace,
  processSandboxFactory: ((workspaceRoot: string) => AgentProcessSandbox) | undefined
): boolean {
  return server.enabled
    && (server.transport !== 'stdio' || processSandboxFactory !== undefined)
    && (
      server.transport !== 'stdio'
      || server.workspaceAccess !== 'write'
      || workspace.access === 'write'
    );
}

function requireProcessSandboxFactory(
  factory: ((workspaceRoot: string) => AgentProcessSandbox) | undefined,
  workspaceRoot: string
): AgentProcessSandbox {
  if (factory === undefined) throw new Error('mcp_stdio_sandbox_runtime_unavailable');
  return factory(workspaceRoot);
}

function boundedJson(value: unknown): AgentToolJsonValue {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_MCP_RESULT_BYTES) {
    throw new Error('mcp_result_exceeds_limit');
  }
  return JSON.parse(json) as AgentToolJsonValue;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
