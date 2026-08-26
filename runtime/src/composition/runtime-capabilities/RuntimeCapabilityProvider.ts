import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { RuntimeCapability } from '@ariadne/protocol/public';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HostCapabilityClient } from '../../ingress/HostCapabilityClient.js';
import type { RuntimeCapabilityDefinitionSnapshot } from '../../ingress/RuntimeCapabilityManifest.js';
import type { ShutdownContext } from '../../ingress/ShutdownContext.js';
import type { FirstPartyProcessSandboxFactory, WorkspaceBinding } from '../first-party-tools/FirstPartyAgentToolSupport.js';

export interface RuntimeCapabilityStartContext {
  readonly bootstrap: RuntimeBootstrap;
  readonly hostCapabilities: HostCapabilityClient;
  readonly workspaceBindings: ReadonlyMap<string, WorkspaceBinding>;
  readonly authorizedMcpServers: readonly RuntimePolicySnapshot['mcp']['servers'][number][];
  readonly processSandboxFactory?: FirstPartyProcessSandboxFactory;
}

export interface RuntimeCapabilityHandle {
  readonly publicCapabilities: readonly RuntimeCapability[];
  readonly tools?: readonly TrustedAgentToolRegistrationV1[];
  prepareShutdown?(context: ShutdownContext): void | Promise<void>;
  close?(context: ShutdownContext): void | Promise<void>;
}

export interface RuntimeCapabilityProvider {
  readonly definition: RuntimeCapabilityDefinitionSnapshot;
  start(context: RuntimeCapabilityStartContext): RuntimeCapabilityHandle | Promise<RuntimeCapabilityHandle>;
}

export function defineRuntimeCapabilityProvider(
  id: string,
  requires: readonly string[],
  provides: readonly string[],
  publicCapabilities: readonly RuntimeCapability[],
  start: RuntimeCapabilityProvider['start']
): RuntimeCapabilityProvider {
  return Object.freeze({
    definition: Object.freeze({
      id,
      contractVersion: '1.0',
      requires: Object.freeze([...requires]),
      provides: Object.freeze([...provides]),
      publicCapabilities: Object.freeze([...publicCapabilities])
    }),
    start
  });
}
