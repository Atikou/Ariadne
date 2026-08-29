import {
  AgentPlanBudgetChildRunService,
  deriveStableAgentId,
  type AgentRun,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

export interface AgentChildTerminalObservationRequest {
  readonly run: AgentRun;
  readonly sourceRunEventId: string;
  readonly occurredAt: string;
}

/** Commits one terminal Child fact and releases its exact delegated budget. */
export class AgentChildTerminalObservationCoordinator {
  private readonly children: AgentPlanBudgetChildRunService;

  public constructor(private readonly unitOfWork: AgentRunUnitOfWork) {
    this.children = new AgentPlanBudgetChildRunService(unitOfWork);
  }

  public async observeTerminalChild(
    request: AgentChildTerminalObservationRequest
  ): Promise<unknown> {
    const objective = request.run.binding.objectiveRef;
    if (objective.kind !== 'parent_delegation') {
      throw new Error('Child terminal observation requires a delegated Child Run.');
    }
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
    const parent = await this.unitOfWork.transaction((transaction) => (
      transaction.loadRun(objective.parentRunId)
    ));
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
      childStatus: terminalStatus(request.run.state.status)
    });
  }
}

function terminalStatus(
  status: string
): 'completed' | 'failed' | 'cancelled' {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  throw new Error('SubAgent result projection requires one terminal child Run.');
}
