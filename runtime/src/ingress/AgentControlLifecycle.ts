import type {
  AgentAdmissionAuthoritySource,
  RuntimeBootstrap
} from '@ariadne/protocol/host';

import type { HostCapabilityClient } from './HostCapabilityClient.js';
import type { RuntimeCommandReconciliation } from '../control/ports/RuntimeCommandJournal.js';
import type {
  RuntimeApplicationCommandResult
} from './RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from './RuntimeIngress.js';
import type { ShutdownContext } from './ShutdownContext.js';
import type { RuntimeModelCatalogSource } from './RuntimeModelCatalog.js';
import type { RuntimePublicEventSink } from './RuntimePublicEventSink.js';
import type {
  ExactAgentModelInferenceRuntime
} from '../control/ports/AgentModelInference.js';
import type { AgentToolCatalogSnapshot } from '../control/ports/AgentToolExecution.js';
import type { AgentRuntimeTelemetry } from '../control/ports/AgentLifecycleObservability.js';
import type { AgentControlLiveWorkService } from '../control/ports/AgentLiveWork.js';
import type { AgentProcessSandbox } from '../control/ports/AgentProcessSandbox.js';
import type { AgentInstructionAssemblyService } from '../control/ports/AgentInstructionAssembly.js';
import type { AgentLifecycleHookService } from '../control/ports/AgentLifecycleHooks.js';
import type { HumanSkillCatalog } from '../control/ports/HumanSkillCatalog.js';

/** Provider-composed services consumed by Agent Control after Store creation. */
export interface AgentControlRuntimeServices {
  readonly instructionAssembly: AgentInstructionAssemblyService;
  readonly lifecycleHooks: AgentLifecycleHookService;
  readonly telemetry?: AgentRuntimeTelemetry;
  readonly liveWorkLifecycle?: AgentControlLiveWorkService;
  readonly processSandboxForWorkspace?: (workspaceRoot: string) => AgentProcessSandbox;
  readonly humanSkillCatalog?: HumanSkillCatalog;
}

export interface AgentControlRuntimeLifecycle {
  readonly schemaVersion: number;
  readonly storageSchemas: Readonly<Record<string, number>>;
  start(): Promise<void>;
  assertHealthy(): void;
  /** Returns null only when this control plane does not own the command kind. */
  executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null>;
  /** Returns null only when another domain owns reconciliation for this kind. */
  reconcileUncertainCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandReconciliation | null>;
  prepareShutdown(context: ShutdownContext): Promise<void>;
  shutdown(context: ShutdownContext): Promise<void>;
}

export interface AgentControlRuntimeFactoryInput {
  readonly dataRoot: string;
  readonly installRoot?: string;
  readonly production: boolean;
  readonly runtimeInstanceId: string;
  /** Exact, already-validated Host bootstrap authority. No Runtime defaulting. */
  readonly agentAdmissionAuthoritySource: AgentAdmissionAuthoritySource;
  /** Immutable Provider transport snapshot paired with the authority revision. */
  readonly modelProviders: RuntimeBootstrap['modelProviders'];
  /** Frozen, enabled external SubAgent backends supplied by Main. */
  readonly subagentProviders?: RuntimeBootstrap['subagentProviders'];
  /** Exact Workspace roots used by the first-party executable Tool Catalog. */
  readonly workspaces?: RuntimeBootstrap['workspaces'];
  /** Exact immutable extension policy snapshot supplied by Main. */
  readonly runtimePolicy?: RuntimeBootstrap['runtimePolicy'];
  /** Process environment supplied explicitly to Provider credential binding. */
  readonly credentialEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Bound before start; reads the one Runtime-owned, public-safe model catalog. */
  readonly modelCatalog: RuntimeModelCatalogSource;
  /** Exact inference owned by the Runtime model domain. */
  readonly modelInferenceGateway?: ExactAgentModelInferenceRuntime;
  /** Composition-gated queue for non-authoritative Projection wake hints. */
  readonly publicEventSink: RuntimePublicEventSink;
  readonly hostCapabilities: HostCapabilityClient;
  /** The immutable Tool Catalog compiled from the same Provider graph as Runtime status. */
  readonly agentToolCatalogSnapshots?: readonly AgentToolCatalogSnapshot[];
  /** One typed bundle assembled by a service-consuming Capability Provider. */
  readonly runtimeServices?: AgentControlRuntimeServices;
}

/**
 * Composition-owned factory. Transport coordinates lifecycle only and never
 * constructs Agent persistence or encryption adapters itself.
 */
export interface AgentControlRuntimeFactory {
  create(
    input: AgentControlRuntimeFactoryInput
  ): Promise<AgentControlRuntimeLifecycle>;
}
