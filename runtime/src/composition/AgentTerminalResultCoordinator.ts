import {
  AgentPlanBudgetChildRunService,
  deriveStableAgentId,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';
import type {
  AgentRunTerminalResultProjectionRequest,
  AgentRunTerminalResultProjectionSink
} from '../projection/AgentRunProjectionPorts.js';

/** Routes terminal Runs to their exact root or parent-Delegation product owner. */
export class AgentTerminalResultCoordinator
implements AgentRunTerminalResultProjectionSink {
  private readonly children: AgentPlanBudgetChildRunService;

  public constructor(
    private readonly unitOfWork: AgentRunUnitOfWork,
    private readonly conversations: AgentRunTerminalResultProjectionSink
  ) {
    this.children = new AgentPlanBudgetChildRunService(unitOfWork);
  }

  public async projectTerminalResult(
    request: AgentRunTerminalResultProjectionRequest
  ): Promise<unknown> {
    const objective = request.run.binding.objectiveRef;
    if (objective.kind !== 'parent_delegation') {
      return this.conversations.projectTerminalResult(request);
    }
    const status = terminalStatus(request.run.state.status);
    const commandId = await deriveStableAgentId(
      'child-terminal-observation',
      request.sourceRunEventId,
      request.run.runId,
      String(request.run.version)
    );
    const replay = await this.unitOfWork.transaction((transaction) => (
      transaction.loadCommittedCommand(commandId)
    ));
    if (replay !== null) return replay;
    const parent = await this.childrenRun(objective.parentRunId);
    if (parent === null) throw new Error('Delegated child terminal has no parent Run.');
    const occurredAt = new Date(Math.max(
      Date.parse(request.occurredAt),
      Date.parse(parent.updatedAt)
    )).toISOString();
    return this.children.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId,
      runId: objective.parentRunId,
      expectedVersion: parent.version,
      occurredAt,
      childRunId: request.run.runId,
      childRunVersion: request.run.version,
      childStatus: status
    });
  }

  private childrenRun(parentRunId: string) {
    return this.unitOfWork.transaction((transaction) => transaction.loadRun(parentRunId));
  }
}

function terminalStatus(
  status: string
): 'completed' | 'failed' | 'cancelled' {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  throw new Error('SubAgent result projection requires one terminal child Run.');
}
