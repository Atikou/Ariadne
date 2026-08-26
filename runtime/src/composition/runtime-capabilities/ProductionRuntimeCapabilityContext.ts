import path from 'node:path';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { AgentProcessSandboxFactory } from '../../control/ports/AgentProcessSandbox.js';
import type { HostCapabilityClient } from '../../ingress/HostCapabilityClient.js';
import type { FirstPartyProcessSandboxFactory, WorkspaceBinding } from '../first-party-tools/FirstPartyAgentToolSupport.js';
import type { RuntimeCapabilityStartContext } from './RuntimeCapabilityProvider.js';

export interface ProductionRuntimeCapabilityManifestInput {
  readonly bootstrap: RuntimeBootstrap;
  readonly hostCapabilities?: HostCapabilityClient;
  readonly processSandboxFactory?: AgentProcessSandboxFactory;
}

const UNAVAILABLE_HOST_CAPABILITIES: HostCapabilityClient = Object.freeze({
  request: async (): Promise<Record<string, unknown>> => {
    throw new Error('host_capability_unavailable');
  }
});

export function createProductionRuntimeCapabilityStartContext(
  input: ProductionRuntimeCapabilityManifestInput
): RuntimeCapabilityStartContext {
  const hostCapabilities = input.hostCapabilities ?? UNAVAILABLE_HOST_CAPABILITIES;
  const processSandboxFactory = createProcessSandboxFactory(input);
  return Object.freeze({
    bootstrap: input.bootstrap,
    hostCapabilities,
    workspaceBindings: workspaceBindings(input.bootstrap.workspaces),
    authorizedMcpServers: Object.freeze(authorizedMcpServers(input.bootstrap)),
    ...(processSandboxFactory === undefined ? {} : { processSandboxFactory })
  });
}

function createProcessSandboxFactory(
  input: ProductionRuntimeCapabilityManifestInput
): FirstPartyProcessSandboxFactory | undefined {
  const permissions = input.bootstrap.agentPermissions;
  if (permissions === undefined || input.processSandboxFactory === undefined) return undefined;
  return (workspaceRoot) => input.processSandboxFactory!({
    workspaceRoot,
    installRoot: input.bootstrap.installRoot,
    production: input.bootstrap.production,
    mode: permissions.sandboxMode,
    allowedPermissions: [...permissions.allowedPermissions]
  });
}

function authorizedMcpServers(
  bootstrap: RuntimeBootstrap
): RuntimePolicySnapshot['mcp']['servers'] {
  const permissions = new Set(bootstrap.agentPermissions?.allowedPermissions ?? []);
  return bootstrap.runtimePolicy.mcp.servers.filter((server) => {
    if (!server.enabled) return false;
    if (server.transport === 'streamable-http') return permissions.has('network');
    return permissions.has('shell')
      && (server.workspaceAccess !== 'write' || permissions.has('write'))
      && (server.networkAccess !== 'online-approved' || permissions.has('network'));
  });
}

function workspaceBindings(
  workspaces: RuntimeBootstrap['workspaces']
): ReadonlyMap<string, WorkspaceBinding> {
  const roots = new Map<string, WorkspaceBinding>();
  for (const workspace of workspaces) {
    if (roots.has(workspace.workspaceId)) throw new Error('runtime_capability_workspace_duplicate');
    roots.set(workspace.workspaceId, Object.freeze({
      rootPath: path.resolve(workspace.rootPath),
      access: workspace.access
    }));
  }
  return roots;
}
