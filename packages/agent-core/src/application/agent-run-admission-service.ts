import type { AdmitAgentRunCommand } from './commands.js';
import {
  AgentRunCommandService,
  type AgentRunCommandResult
} from './agent-run-command-service.js';
import type {
  AgentRunCheckpointPayload,
  AgentTurnInputSnapshotV1
} from './recovery-persistence.js';
import type { AgentRunUnitOfWork } from './unit-of-work.js';

export interface AdmitAgentRunRequest {
  readonly command: AdmitAgentRunCommand;
  /** Recovery payload stored atomically with Run, Turn, events, and receipt. */
  readonly checkpoint: AgentRunCheckpointPayload;
  /** Exact protected model input stored atomically with the admitted Turn. */
  readonly turnInput: AgentTurnInputSnapshotV1;
}

export type AgentRunAdmissionResult = AgentRunCommandResult;

/** The production admission path: exactly one command and one UoW transaction. */
export class AgentRunAdmissionService {
  private readonly commands: AgentRunCommandService;

  public constructor(unitOfWork: AgentRunUnitOfWork) {
    this.commands = new AgentRunCommandService(unitOfWork);
  }

  public admit(request: AdmitAgentRunRequest): Promise<AgentRunAdmissionResult> {
    return this.commands.execute(request.command, {
      checkpoint: {
        checkpointVersion: 1,
        payload: request.checkpoint,
        createdAt: request.command.occurredAt
      },
      turnInputPayloads: [{
        turnId: request.command.turn.turnId,
        inputDigest: request.command.turn.inputDigest,
        payload: request.turnInput,
        recordedAt: request.command.occurredAt
      }],
      effectPayloads: []
    });
  }
}
