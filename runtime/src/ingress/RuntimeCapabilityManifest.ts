import type { ComponentCatalog } from '@ariadne/component-contracts';
import type { RuntimeCapability } from '@ariadne/protocol/public';

import type { AgentToolCatalogSnapshot } from '../control/ports/AgentToolExecution.js';
import type { ShutdownContext } from './ShutdownContext.js';

export interface RuntimeCapabilityDefinitionSnapshot {
  readonly id: string;
  readonly contractVersion: string;
  /** Provider-only ordering constraints that do not masquerade as services. */
  readonly dependsOn: readonly string[];
  /** Services this Provider is authorized to consume during start. */
  readonly consumes: readonly RuntimeCapabilityServiceDependencySnapshot[];
  /** Actual service instances this Provider may publish. */
  readonly provides: readonly RuntimeCapabilityServiceProvisionSnapshot[];
  readonly publicCapabilities: readonly RuntimeCapability[];
}

export interface RuntimeCapabilityServiceDependencySnapshot {
  readonly serviceId: string;
  readonly optional: boolean;
}

export interface RuntimeCapabilityServiceProvisionSnapshot {
  readonly serviceId: string;
  readonly optional: boolean;
}

export interface RuntimeCapabilityProviderSnapshot {
  readonly definition: RuntimeCapabilityDefinitionSnapshot;
  readonly status: 'started';
  readonly publicCapabilities: readonly RuntimeCapability[];
  readonly toolNames: readonly string[];
}

/**
 * Bootstrap-frozen result of starting the configured capability providers.
 * Consumers receive only verified services and public-safe diagnostics; they
 * cannot register providers or mutate assembly after bootstrap.
 */
export interface RuntimeCapabilityManifest {
  readonly agentComponentCatalog: ComponentCatalog;
  readonly publicCapabilities: readonly RuntimeCapability[];
  readonly unwiredPublicCapabilities: readonly RuntimeCapability[];
  readonly agentToolCatalogSnapshots: readonly AgentToolCatalogSnapshot[];
  /** Resolves only bootstrap-frozen services declared by started Providers. */
  service<T>(serviceId: string): T | undefined;
  diagnosticSnapshot(): readonly RuntimeCapabilityProviderSnapshot[];
  prepareShutdown(context: ShutdownContext): Promise<void>;
  close(context: ShutdownContext): Promise<void>;
}
