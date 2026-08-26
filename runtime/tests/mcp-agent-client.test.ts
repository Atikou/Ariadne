import { describe, expect, it, vi } from 'vitest';

import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';

import {
  ProductionMcpAgentClient,
  type McpAgentConnection
} from '../src/adapters/mcp/ProductionMcpAgentClient.js';

const servers: RuntimePolicySnapshot['mcp']['servers'] = [{
  id: 'docs',
  enabled: true,
  trustAnnotations: false,
  transport: 'streamable-http',
  endpoint: 'https://mcp.example.com/'
}, {
  id: 'disabled',
  enabled: false,
  trustAnnotations: false,
  transport: 'streamable-http',
  endpoint: 'https://disabled.example.com/'
}, {
  id: 'local',
  enabled: true,
  trustAnnotations: false,
  transport: 'stdio',
  command: 'mcp-server.exe',
  args: [],
  environmentAllowlist: [],
  workspaceAccess: 'read',
  networkAccess: 'offline'
}];
const workspace = { rootPath: process.cwd(), access: 'write' as const };

describe('ProductionMcpAgentClient', () => {
  it('lists and calls enabled remote servers through a bounded one-operation connection', async () => {
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const connection: McpAgentConnection = {
      listTools: async () => ({
        tools: [{
          name: 'search',
          description: 'Search documentation',
          inputSchema: { type: 'object' }
        }]
      }),
      callTool,
      close
    };
    const factory = vi.fn(async () => connection);
    const client = new ProductionMcpAgentClient(
      servers,
      { request: vi.fn() },
      factory
    );
    const signal = new AbortController().signal;

    expect(client.listServerIds(workspace)).toEqual(['docs']);
    expect(await client.listTools('docs', signal, workspace)).toEqual({
      serverId: 'docs',
      tools: [{
        name: 'search',
        description: 'Search documentation',
        inputSchema: { type: 'object' }
      }],
      truncated: false
    });
    expect(await client.callTool('docs', 'search', { query: 'Ariadne' }, signal, workspace))
      .toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(callTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { query: 'Ariadne' }
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('fails closed for disabled servers and stdio without a sandbox runtime', async () => {
    const client = new ProductionMcpAgentClient(
      servers,
      { request: vi.fn() },
      vi.fn(async () => { throw new Error('must_not_connect'); })
    );
    const signal = new AbortController().signal;
    await expect(client.listTools('disabled', signal, workspace)).rejects.toThrow(
      'mcp_server_not_enabled_for_workspace'
    );
    await expect(client.listTools('local', signal, workspace)).rejects.toThrow(
      'mcp_server_not_enabled_for_workspace'
    );
  });

  it('admits stdio only through an injected interactive sandbox boundary', async () => {
    const connection: McpAgentConnection = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => undefined
    };
    const factory = vi.fn(async () => connection);
    const processSandboxFactory = vi.fn(() => ({ mode: 'workspace-write' } as never));
    const client = new ProductionMcpAgentClient(
      servers,
      { request: vi.fn() },
      factory,
      processSandboxFactory
    );
    const signal = new AbortController().signal;

    expect(client.listServerIds(workspace)).toEqual(['docs', 'local']);
    await expect(client.listTools('local', signal, workspace)).resolves.toMatchObject({
      serverId: 'local',
      tools: []
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local', transport: 'stdio' }),
      expect.anything(),
      signal,
      workspace.rootPath,
      processSandboxFactory
    );
  });
});
