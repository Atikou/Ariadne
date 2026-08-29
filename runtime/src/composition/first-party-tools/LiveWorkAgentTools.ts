import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { AgentLiveWorkService } from '../../control/resources/AgentLiveWorkService.js';
import { AgentProcessLiveWorkProducer } from '../../control/resources/AgentProcessLiveWorkProducer.js';
import { AgentTerminalLiveWorkProducer } from '../../control/resources/AgentTerminalLiveWorkProducer.js';
import type { WorkspaceBinding } from './FirstPartyAgentToolSupport.js';
import { createLiveWorkControlAgentToolRegistrations } from './LiveWorkControlAgentTools.js';
import { createLiveWorkStartAgentToolRegistrations } from './LiveWorkStartAgentTools.js';

/** Composition-only entry: producer creation and generic job control stay separate. */
export function createLiveWorkAgentToolRegistrations(
  roots: ReadonlyMap<string, WorkspaceBinding>,
  liveWork: AgentLiveWorkService,
  processes: AgentProcessLiveWorkProducer,
  terminals: AgentTerminalLiveWorkProducer
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    ...createLiveWorkStartAgentToolRegistrations(roots, processes, terminals),
    ...createLiveWorkControlAgentToolRegistrations(roots, liveWork)
  ];
}
