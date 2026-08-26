import type { RuntimeBootstrap, RuntimeResponse } from '@ariadne/protocol/host';
import type { RuntimeEventEnvelope, RuntimeStatus } from '@ariadne/protocol/public';

import type { HostCapabilityClient } from './HostCapabilityClient.js';
import type { RuntimeCommandEnvelope } from './RuntimeIngress.js';
import type { ShutdownContext } from './ShutdownContext.js';
import type { RuntimePublicEventSink } from './RuntimePublicEventSink.js';
import type { RuntimeModelCatalogSource } from './RuntimeModelCatalog.js';
import type {
  ExactAgentModelInferenceRuntime
} from '../control/ports/AgentModelInference.js';
import type { RuntimeCapabilityManifest } from './RuntimeCapabilityManifest.js';

export interface RuntimeApplicationCommandResult {
  readonly outcome: RuntimeResponse['outcome'];
  readonly settlement: 'completed' | 'uncertain';
}

/** Narrow lifecycle/command port around the legacy Runtime application. */
export interface RuntimeApplication {
  readonly storageSchemas: Readonly<Record<string, number>>;
  readonly publicEventSink: RuntimePublicEventSink;
  readonly modelCatalog: RuntimeModelCatalogSource;
  /** Exact model execution owned by the same model domain as modelCatalog. */
  readonly modelInferenceGateway?: ExactAgentModelInferenceRuntime;
  start(): Promise<void>;
  execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult>;
  status(): RuntimeStatus;
  prepareShutdown(context: ShutdownContext): Promise<void>;
  stop(context: ShutdownContext): Promise<void>;
  shutdown(context: ShutdownContext): Promise<void>;
  disposeInitialization(context: ShutdownContext): Promise<void>;
}

export interface RuntimeApplicationFactoryInput {
  readonly bootstrap: RuntimeBootstrap;
  readonly capabilityManifest: RuntimeCapabilityManifest;
  readonly hostCapabilities?: HostCapabilityClient;
  readonly emitEvent: (event: RuntimeEventEnvelope) => void;
  readonly runtimeVersion: string;
}

export interface RuntimeApplicationFactory {
  create(input: RuntimeApplicationFactoryInput): Promise<RuntimeApplication>;
}
