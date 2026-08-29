import {
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';
import {
  AgentChildTerminalObservationCoordinator
} from '../control/execution/AgentChildTerminalObservationCoordinator.js';
import type {
  AgentRunTerminalResultProjectionRequest,
  AgentRunTerminalResultProjectionSink
} from '../projection/AgentRunProjectionPorts.js';

/** Routes terminal Runs to their exact root or parent-Delegation product owner. */
export class AgentTerminalResultCoordinator
implements AgentRunTerminalResultProjectionSink {
  private readonly children: AgentChildTerminalObservationCoordinator;

  public constructor(
    unitOfWork: AgentRunUnitOfWork,
    private readonly conversations: AgentRunTerminalResultProjectionSink
  ) {
    this.children = new AgentChildTerminalObservationCoordinator(unitOfWork);
  }

  public async projectTerminalResult(
    request: AgentRunTerminalResultProjectionRequest
  ): Promise<unknown> {
    const objective = request.run.binding.objectiveRef;
    if (objective.kind !== 'parent_delegation') {
      return this.conversations.projectTerminalResult(request);
    }
    return this.children.observeTerminalChild(request);
  }
}
