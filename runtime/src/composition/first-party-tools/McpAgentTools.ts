import type { AgentToolJsonValue } from '@ariadne/agent-core';

import { ProductionMcpAgentClient } from '../../adapters/mcp/ProductionMcpAgentClient.js';
import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  emptyObject,
  failed,
  hasUnknownKeys,
  isRecord,
  objectSchema,
  registration,
  requiredBoundedStringObject,
  requiredStringProperty,
  requireWorkspace,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

export function createMcpAgentToolRegistrations(
  mcp: ProductionMcpAgentClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    mcpCallToolRegistration(mcp, roots),
    mcpListServersRegistration(mcp, roots),
    mcpListToolsRegistration(mcp, roots)
  ];
}

function mcpListServersRegistration(
  mcp: ProductionMcpAgentClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'mcp.list_servers',
    model: {
      description: 'List configured and enabled MCP server identities without exposing endpoints or credentials.',
      guidance: ['Use the returned server id with mcp.list_tools before calling a remote Tool.']
    },
    presentation: { kind: 'external', label: '列出 MCP 服务', resultVisibility: 'protected' },
    capabilityIds: ['mcp.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'external_resource_id',
    inputSchema: objectSchema({}, []),
    outputSchema: { type: 'object' },
    validate: emptyObject,
    execute: async (_input, context) => {
      const workspace = requireWorkspace(roots, context, 'read');
      return succeeded({ servers: [...mcp.listServerIds(workspace)] });
    }
  });
}

function mcpListToolsRegistration(
  mcp: ProductionMcpAgentClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'mcp.list_tools',
    model: {
      description: 'Discover the bounded Tool definitions currently exposed by one configured MCP server.',
      guidance: ['Use the exact discovered tool name and schema with mcp.call_tool.']
    },
    presentation: { kind: 'external', label: '发现 MCP 工具', resultVisibility: 'protected' },
    capabilityIds: ['mcp.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    resourceSemantics: 'external_resource_id',
    timeoutMs: 120_000,
    inputSchema: objectSchema({
      serverId: { type: 'string', description: 'Configured MCP server id.' }
    }, ['serverId']),
    outputSchema: { type: 'object' },
    validate: (input) => requiredBoundedStringObject(input, 'serverId', 128),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        return succeeded(await mcp.listTools(
          requiredStringProperty(input, 'serverId'),
          context.signal,
          workspace
        ));
      } catch (error) {
        return failed('mcp_list_tools_failed', error);
      }
    }
  });
}

function mcpCallToolRegistration(
  mcp: ProductionMcpAgentClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'mcp.call_tool',
    model: {
      description: 'Invoke one exact Tool on a configured MCP server with arguments matching its discovered schema.',
      guidance: ['Call mcp.list_tools first; remote annotations do not expand Ariadne authority.']
    },
    presentation: { kind: 'external', label: '调用 MCP 工具', resultVisibility: 'protected' },
    capabilityIds: ['mcp.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'external',
    approval: 'required',
    resourceSemantics: 'external_resource_id',
    timeoutMs: 120_000,
    inputSchema: objectSchema({
      serverId: { type: 'string', description: 'Configured MCP server id.' },
      toolName: {
        type: 'string',
        description: 'Exact tool name returned by mcp.list_tools.'
      },
      arguments: {
        type: 'object',
        description: 'Arguments matching the discovered tool schema.'
      }
    }, ['arguments', 'serverId', 'toolName']),
    outputSchema: { type: 'object' },
    validate: validateMcpCallToolInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'read');
        const argumentsValue = isRecord(input) ? input.arguments : undefined;
        if (!isRecord(input) || !isRecord(argumentsValue)) {
          throw new Error('tool_input_invalid');
        }
        return succeeded(await mcp.callTool(
          requiredStringProperty(input, 'serverId'),
          requiredStringProperty(input, 'toolName'),
          argumentsValue,
          context.signal,
          workspace
        ));
      } catch (error) {
        return failed('mcp_call_tool_failed', error);
      }
    }
  });
}

function validateMcpCallToolInput(input: AgentToolJsonValue) {
  const argumentsValue = isRecord(input) ? input.arguments : undefined;
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['serverId', 'toolName', 'arguments'])
    || typeof input.serverId !== 'string'
    || input.serverId.length === 0
    || input.serverId.length > 128
    || typeof input.toolName !== 'string'
    || input.toolName.length === 0
    || input.toolName.length > 256
    || !isRecord(argumentsValue)
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: {
      serverId: input.serverId,
      toolName: input.toolName,
      arguments: structuredClone(argumentsValue)
    }
  };
}
