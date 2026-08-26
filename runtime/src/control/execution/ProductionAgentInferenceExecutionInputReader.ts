import {
  AgentRunInvariantError,
  assertAgentTurnInputSnapshotMatchesTurn,
  assertValidAgentRun,
  cloneAgentAvailableTool,
  type AgentInferenceExecutionInput,
  type AgentInferenceExecutionInputReader,
  type AgentJsonValue,
  type AgentRunUnitOfWork,
  type AgentTurnInputPayloadReader
} from '@ariadne/agent-core';

/** Reads only the exact protected schema-v5 Turn snapshot; no live-authority rebuild exists. */
export class ProductionAgentInferenceExecutionInputReader
implements AgentInferenceExecutionInputReader {
  public constructor(
    private readonly runs: AgentRunUnitOfWork,
    private readonly turnInputs: AgentTurnInputPayloadReader
  ) {}

  public async loadInferenceExecutionInput(
    runId: string,
    turnId: string,
    attemptId: string
  ): Promise<AgentInferenceExecutionInput> {
    const run = await this.runs.transaction((transaction) => transaction.loadRun(runId));
    if (run === null) throw invariant('The execution input Run does not exist.');
    assertValidAgentRun(run);
    const turn = run.turns.find((candidate) => candidate.turnId === turnId);
    const attempt = turn?.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (turn === undefined || attempt === undefined) {
      throw invariant('The execution input does not match the exact Turn and Attempt.');
    }

    const snapshot = await this.turnInputs.loadTurnInputPayload({
      runId,
      turnId,
      inputDigest: turn.intention.inputDigest
    });
    try {
      await assertAgentTurnInputSnapshotMatchesTurn(
        run,
        turnId,
        turn.intention.inputDigest,
        snapshot
      );
    } catch (error) {
      throw invariant('The protected Turn input differs from the exact current Run intention.', error);
    }
    return {
      runId,
      turnId,
      attemptId,
      inputDigest: turn.intention.inputDigest,
      input: {
        run,
        messages: snapshot.messages.map((message) => message.kind === 'text'
          ? { kind: 'text', role: message.role, content: message.content }
          : {
              kind: 'effect_result',
              effectId: message.effectId,
              toolCallId: message.toolCallId,
              status: message.status,
              result: cloneJsonValue(message.result)
            }),
        availableTools: snapshot.availableTools.map((available, index) => (
          cloneAgentAvailableTool(available, `executionInput.availableTools[${String(index)}]`)
        ))
      }
    };
  }
}

function cloneJsonValue(value: AgentJsonValue): AgentJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])
  );
}

function invariant(message: string, cause?: unknown): AgentRunInvariantError {
  return new AgentRunInvariantError(
    cause instanceof Error ? `${message} (${cause.name})` : message
  );
}
