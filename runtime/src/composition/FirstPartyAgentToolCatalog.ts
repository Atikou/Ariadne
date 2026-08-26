import path from 'node:path';

import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import {
  FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
  FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';

import { ProductionMcpAgentClient } from '../adapters/mcp/ProductionMcpAgentClient.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogSnapshot
} from '../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HostCapabilityClient } from '../ingress/HostCapabilityClient.js';
import {
  createBrowserAgentToolRegistrations
} from './first-party-tools/BrowserAgentTools.js';
import {
  type FirstPartyProcessSandboxFactory,
  type WorkspaceBinding
} from './first-party-tools/FirstPartyAgentToolSupport.js';
import {
  createMcpAgentToolRegistrations
} from './first-party-tools/McpAgentTools.js';
import {
  createWorkspaceAgentToolRegistrations
} from './first-party-tools/WorkspaceAgentTools.js';

export type {
  FirstPartyProcessSandboxFactory
} from './first-party-tools/FirstPartyAgentToolSupport.js';

/**
 * Composes immutable first-party Tool families. Individual schemas,
 * validation and execution belong to their capability-family modules.
 */
export function createFirstPartyAgentToolCatalog(
  workspaces: RuntimeBootstrap['workspaces'],
  hostCapabilities?: HostCapabilityClient,
  mcpServers: RuntimePolicySnapshot['mcp']['servers'] = [],
  processSandboxFactory?: FirstPartyProcessSandboxFactory
): TrustedAgentToolCatalogSnapshot {
  const browserHost = hostCapabilities ?? Object.freeze({
    request: async (): Promise<Record<string, unknown>> => {
      throw new Error('browser_host_capability_unavailable');
    }
  });
  const roots = workspaceBindings(workspaces);
  const mcp = new ProductionMcpAgentClient(
    mcpServers,
    browserHost,
    undefined,
    processSandboxFactory
  );
  return compileTrustedAgentToolCatalog({
    catalogId: FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
    revision: FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
    tools: [
      ...createBrowserAgentToolRegistrations(browserHost, roots),
      ...createMcpAgentToolRegistrations(mcp, roots),
      ...createWorkspaceAgentToolRegistrations(roots, processSandboxFactory)
    ]
  });
}

function workspaceBindings(
  workspaces: RuntimeBootstrap['workspaces']
): ReadonlyMap<string, WorkspaceBinding> {
  const roots = new Map<string, WorkspaceBinding>();
  for (const workspace of workspaces) {
    if (roots.has(workspace.workspaceId)) {
      throw new Error('first_party_tool_workspace_duplicate');
    }
    roots.set(workspace.workspaceId, {
      rootPath: path.resolve(workspace.rootPath),
      access: workspace.access
    });
  }
  return roots;
}
