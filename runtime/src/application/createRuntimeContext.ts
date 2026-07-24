import path from 'node:path';

import type { RuntimeBootstrap } from '@ariadne/protocol/host';

import { createAppContext, type AppContext } from '../app/createAppContext.js';
import { loadConfig } from '../config/loadConfig.js';
import {
  ProviderQualificationSchema,
  SecurityConfigSchema,
  type ApiModelClientConfig,
  type AppConfig,
  type ModelClientConfig
} from '../config/types.js';
import type { ToolPermission } from '../core/permissions.js';
import type { HostCapabilityBroker } from '../host/HostCapabilityBroker.js';

export function createRuntimeContext(
  bootstrap: RuntimeBootstrap,
  hostCapabilities?: HostCapabilityBroker
): AppContext {
  const projectRoot = path.resolve(bootstrap.installRoot);
  const loaded = loadConfig({
    projectRoot,
    profile: bootstrap.profile
  });
  const primaryWorkspace = bootstrap.workspaces[0];
  if (!primaryWorkspace) throw new Error('runtime_bootstrap_workspace_missing');
  const providerOverrides = bootstrap.modelProviders
    ? new Map(bootstrap.modelProviders.map((provider) => [provider.name, provider]))
    : null;
  const configuredApiClients = new Map(loaded.config.models.clients.flatMap((client) =>
    client.kind === 'api' ? [[client.name, client] as const] : []));
  const clients: ModelClientConfig[] = providerOverrides
    ? [
        ...loaded.config.models.clients.filter((client) => client.kind !== 'api'),
        ...bootstrap.modelProviders!.flatMap((override) => {
          if (!override.enabled) return [];
          const template = configuredApiClients.get(override.name);
          return [buildApiClientConfig(override, template)];
        })
      ]
    : loaded.config.models.clients;
  const permissions = bootstrap.agentPermissions ?? {
    approvalPolicy: 'request' as const,
    proposalApproval: 'manual' as const,
    permissionPolicy: 'confirmBeforeRun' as const,
    sandboxMode: 'workspace-write' as const,
    allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous'] as ToolPermission[]
  };
  const security = applyDesktopPermissionProfile(loaded.config.security, permissions);

  const config: AppConfig = {
    ...loaded.config,
    workspaceRoot: primaryWorkspace.rootPath,
    workspaces: bootstrap.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      label: workspace.label,
      root: workspace.rootPath
    })),
    models: {
      ...loaded.config.models,
      directory: bootstrap.modelRoots[0] ?? path.join(projectRoot, 'Models'),
      embedding: structuredClone(bootstrap.runtimePolicy.embedding),
      clients
    },
    routing: {
      ...loaded.config.routing,
      ...(bootstrap.routingStrategy ? { strategy: bootstrap.routingStrategy } : {})
    },
    mcp: structuredClone(bootstrap.runtimePolicy.mcp),
    skills: structuredClone(bootstrap.runtimePolicy.skills),
    hooks: structuredClone(bootstrap.runtimePolicy.hooks),
    telemetry: structuredClone(bootstrap.runtimePolicy.telemetry),
    providerResilience: structuredClone(bootstrap.runtimePolicy.providerResilience),
    ...(security ? { security } : {})
  };

  return createAppContext({
    projectRoot,
    profile: bootstrap.profile,
    config,
    appDataRoot: bootstrap.dataRoot,
    requireExternalAppDataRoot: true,
    requireTrustedSandboxHelper: bootstrap.production,
    modelDirectories: bootstrap.modelRoots,
    agentHandoffPermissionPolicy: permissions.permissionPolicy,
    hostCapabilities
  });
}

function applyDesktopPermissionProfile(
  security: AppConfig['security'],
  permissions: NonNullable<RuntimeBootstrap['agentPermissions']>
): AppConfig['security'] {
  const baseSecurity = SecurityConfigSchema.parse(security ?? {});
  const unrestricted = permissions.approvalPolicy === 'full-access';
  return {
    ...baseSecurity,
    permissions: { allowed: [...permissions.allowedPermissions] },
    sandbox: {
      ...baseSecurity.sandbox,
      mode: permissions.sandboxMode
    },
    ...(unrestricted ? {
      shell: { denyCommands: [], allowCommands: [] },
      network: { denyDomains: [], allowDomains: [] }
    } : {})
  };
}

function buildApiClientConfig(
  provider: NonNullable<RuntimeBootstrap['modelProviders']>[number],
  template?: ApiModelClientConfig
): ApiModelClientConfig {
  return {
    ...(template ?? {}),
    kind: 'api',
    providerId: provider.providerId,
    protocol: provider.protocol,
    location: 'remote',
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.credentialEnvironmentVariable,
    model: provider.model,
    inference: provider.inference,
    qualification: template?.qualification ?? ProviderQualificationSchema.parse({})
  };
}
