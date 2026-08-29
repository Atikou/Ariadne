import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type { RuntimeCapability } from '@ariadne/protocol/public';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HostCapabilityClient } from '../../ingress/HostCapabilityClient.js';
import type { RuntimeCapabilityDefinitionSnapshot } from '../../ingress/RuntimeCapabilityManifest.js';
import type { ShutdownContext } from '../../ingress/ShutdownContext.js';
import type { FirstPartyProcessSandboxFactory, WorkspaceBinding } from '../first-party-tools/FirstPartyAgentToolSupport.js';

export interface RuntimeCapabilityServiceScope {
  /** Resolve one required service declared by this Provider. */
  required<T>(serviceId: string): T;
  /** Resolve one optional service declared by this Provider. */
  optional<T>(serviceId: string): T | undefined;
}

export interface RuntimeCapabilityStartContext {
  readonly bootstrap: RuntimeBootstrap;
  readonly hostCapabilities: HostCapabilityClient;
  readonly workspaceBindings: ReadonlyMap<string, WorkspaceBinding>;
  readonly authorizedMcpServers: readonly RuntimePolicySnapshot['mcp']['servers'][number][];
  readonly processSandboxFactory?: FirstPartyProcessSandboxFactory;
  /** Provider-scoped dependencies; undeclared reads fail closed. */
  readonly services: RuntimeCapabilityServiceScope;
}

export interface RuntimeCapabilityHandle {
  readonly publicCapabilities: readonly RuntimeCapability[];
  readonly tools?: readonly TrustedAgentToolRegistrationV1[];
  /** Provider-owned services. Keys must be declared in definition.provides. */
  readonly services?: Readonly<Record<string, unknown>>;
  prepareShutdown?(context: ShutdownContext): void | Promise<void>;
  close?(context: ShutdownContext): void | Promise<void>;
}

export interface RuntimeCapabilityProvider {
  readonly definition: RuntimeCapabilityDefinitionSnapshot;
  start(context: RuntimeCapabilityStartContext): RuntimeCapabilityHandle | Promise<RuntimeCapabilityHandle>;
}

export interface RuntimeCapabilityProviderDefinition {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly consumes?: readonly RuntimeCapabilityDefinitionSnapshot['consumes'][number][];
  readonly provides?: readonly RuntimeCapabilityDefinitionSnapshot['provides'][number][];
  readonly publicCapabilities?: readonly RuntimeCapability[];
  readonly start: RuntimeCapabilityProvider['start'];
}

export function defineRuntimeCapabilityProvider(
  input: RuntimeCapabilityProviderDefinition
): RuntimeCapabilityProvider {
  return Object.freeze({
    definition: Object.freeze({
      id: input.id,
      contractVersion: '1.0',
      dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
      consumes: Object.freeze((input.consumes ?? []).map((dependency) => Object.freeze({
        serviceId: dependency.serviceId,
        optional: dependency.optional
      }))),
      provides: Object.freeze((input.provides ?? []).map((provision) => Object.freeze({
        serviceId: provision.serviceId,
        optional: provision.optional
      }))),
      publicCapabilities: Object.freeze([...(input.publicCapabilities ?? [])])
    }),
    start: input.start
  });
}
