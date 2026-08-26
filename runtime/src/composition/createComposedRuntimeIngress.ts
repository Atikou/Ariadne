import { SqliteRuntimeCommandJournal } from '../adapters/persistence/SqliteRuntimeCommandJournal.js';
import { preflightMemoryControlShadows } from '../adapters/persistence/memoryControlShadowRetirement.js';
import type { RuntimeApplicationFactory } from '../ingress/RuntimeApplication.js';
import { ComposedRuntimeIngress } from './ComposedRuntimeIngress.js';
import { DefaultAgentControlRuntimeFactory } from './DefaultAgentControlRuntimeFactory.js';
import { readOwnRuntimeBuildManifest } from './runtimeBuildManifest.js';
import type { AgentProcessSandboxFactory } from '../control/ports/AgentProcessSandbox.js';

export interface CreateComposedRuntimeIngressOptions {
  readonly validateBuildIdentity?: boolean;
  readonly processSandboxFactory?: AgentProcessSandboxFactory;
}

export function createComposedRuntimeIngress(
  runtimeApplicationFactory: RuntimeApplicationFactory,
  options: CreateComposedRuntimeIngressOptions = {}
): ComposedRuntimeIngress {
  return new ComposedRuntimeIngress({
    commandJournal: new SqliteRuntimeCommandJournal(),
    agentControlFactory: new DefaultAgentControlRuntimeFactory(),
    preflightMemoryControlShadows,
    runtimeApplicationFactory,
    readBuildManifest: readOwnRuntimeBuildManifest,
    validateBuildIdentity: options.validateBuildIdentity ?? true,
    processSandboxFactory: options.processSandboxFactory
  });
}
