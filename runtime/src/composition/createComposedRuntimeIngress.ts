import { SqliteRuntimeCommandJournal } from '../adapters/persistence/SqliteRuntimeCommandJournal.js';
import { preflightMemoryControlShadows } from '../adapters/persistence/memoryControlShadowRetirement.js';
import { assertCommunicationContractReady } from '../adapters/persistence/CommunicationContractMigration.js';
import type { RuntimeApplicationFactory } from '../ingress/RuntimeApplication.js';
import { ComposedRuntimeIngress } from './ComposedRuntimeIngress.js';
import { DefaultAgentControlRuntimeFactory } from './DefaultAgentControlRuntimeFactory.js';
import { readOwnRuntimeBuildManifest } from './runtimeBuildManifest.js';
import type { AgentProcessSandboxFactory } from '../control/ports/AgentProcessSandbox.js';
import type { RuntimeStartupTrace } from './RuntimeStartupTrace.js';

export interface CreateComposedRuntimeIngressOptions {
  readonly validateBuildIdentity?: boolean;
  readonly processSandboxFactory?: AgentProcessSandboxFactory;
  readonly startupTrace?: RuntimeStartupTrace;
}

export function createComposedRuntimeIngress(
  runtimeApplicationFactory: RuntimeApplicationFactory,
  options: CreateComposedRuntimeIngressOptions = {}
): ComposedRuntimeIngress {
  const commandJournal = new SqliteRuntimeCommandJournal();
  return new ComposedRuntimeIngress({
    commandJournal, journalHealth: commandJournal,
    agentControlFactory: new DefaultAgentControlRuntimeFactory({}, undefined, options.startupTrace),
    preflightMemoryControlShadows,
    preflightCommunicationContract: assertCommunicationContractReady,
    runtimeApplicationFactory,
    readBuildManifest: readOwnRuntimeBuildManifest,
    validateBuildIdentity: options.validateBuildIdentity ?? true,
    processSandboxFactory: options.processSandboxFactory,
    startupTrace: options.startupTrace
  });
}
