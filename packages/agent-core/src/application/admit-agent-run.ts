import {
  type AgentRun,
  type AgentRunState,
  assertValidAgentRun
} from '../domain/agent-run.js';
import type {
  AgentInferenceAttempt,
  AgentTurn
} from '../domain/turn.js';
import {
  cloneAgentExecutionProfile,
  cloneAgentRunBinding
} from '../domain/run-binding.js';
import type { AdmitAgentRunCommand } from './commands.js';
import type { AgentRunEventPayload } from './events.js';

export interface AgentRunAdmissionTransition {
  readonly run: AgentRun;
  readonly events: readonly AgentRunEventPayload[];
}

/** Pure aggregate creation; persistence is one AgentRunCommandService commit. */
export function admitAgentRun(
  command: AdmitAgentRunCommand
): AgentRunAdmissionTransition {
  const binding = cloneAgentRunBinding(command.binding);
  const state: AgentRunState = {
    status: 'running',
    checkpointVersion: 1,
    enteredAt: command.occurredAt
  };
  const attempt: AgentInferenceAttempt = {
    attemptId: command.turn.attemptId,
    turnId: command.turn.turnId,
    runId: command.runId,
    providerIdempotencyKey: command.turn.providerIdempotencyKey,
    cause: { kind: 'initial' },
    state: {
      status: 'intended',
      intendedAt: command.occurredAt
    }
  };
  const turn: AgentTurn = {
    turnId: command.turn.turnId,
    runId: command.runId,
    intention: {
      expectedRunVersion: null,
      checkpointVersion: 1,
      cause: cloneTurnCause(command.turn.cause),
      bindingVersion: binding.bindingVersion,
      ...(binding.bindingVersion === 4
        ? { executionProfile: cloneAgentExecutionProfile(binding.executionProfile) }
        : {}),
      sessionId: binding.sessionId,
      objectiveRef: binding.objectiveRef,
      workspace: binding.workspace,
      model: binding.model,
      policy: binding.policy,
      capabilities: binding.capabilities,
      toolCatalog: binding.toolCatalog,
      budget: binding.budget,
      inputDigest: command.turn.inputDigest,
      inputSummary: { ...command.turn.inputSummary }
    },
    attempts: [attempt],
    createdAt: command.occurredAt
  };
  const run: AgentRun = {
    runId: command.runId,
    version: 1,
    binding,
    state,
    turns: [turn],
    effects: [],
    inbox: [],
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt
  };
  assertValidAgentRun(run);
  return {
    run,
    events: [
      { type: 'run.admitted', binding: run.binding },
      { type: 'run.state_changed', from: 'absent', to: state },
      { type: 'turn.registered', turn },
      {
        type: 'inference_attempt.registered',
        turnId: turn.turnId,
        attempt
      }
    ]
  };
}

function cloneTurnCause(cause: AdmitAgentRunCommand['turn']['cause']) {
  return { ...cause };
}
