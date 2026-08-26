import type { RuntimeCapability } from '@ariadne/protocol/public';

import type { AgentToolCatalogSnapshot } from '../control/ports/AgentToolExecution.js';
import type { ShutdownContext } from './ShutdownContext.js';

export interface RuntimeCapabilityDefinitionSnapshot {
  readonly id: string;
  readonly contractVersion: string;
  readonly requires: readonly string[];
  readonly provides: readonly string[];
  readonly publicCapabilities: readonly RuntimeCapability[];
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
  readonly publicCapabilities: readonly RuntimeCapability[];
  readonly unwiredPublicCapabilities: readonly RuntimeCapability[];
  readonly agentToolCatalogSnapshots: readonly AgentToolCatalogSnapshot[];
  diagnosticSnapshot(): readonly RuntimeCapabilityProviderSnapshot[];
  prepareShutdown(context: ShutdownContext): Promise<void>;
  close(context: ShutdownContext): Promise<void>;
}
