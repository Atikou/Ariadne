import {
  AgentRunInvariantError,
  assertValidAgentRun,
  type AgentEffectExecutionInput,
  type AgentEffectExecutionInputReader
} from '@ariadne/agent-core';

import type {
  AgentEffectExecutionInputSource
} from '../ports/AgentEffectExecutionInputSource.js';

/** Resolves one protected Effect input against its exact immutable v3 identity. */
export class ProductionAgentEffectExecutionInputReader
implements AgentEffectExecutionInputReader {
  public constructor(private readonly runs: AgentEffectExecutionInputSource) {}

  public async loadEffectExecutionInput(
    runId: string,
    effectId: string
  ): Promise<AgentEffectExecutionInput> {
    const run = await this.runs.transaction((transaction) => transaction.loadRun(runId));
    if (run === null) throw invariant('The execution input Run does not exist.');
    assertValidAgentRun(run);
    if (run.runId !== runId) {
      throw invariant('The execution input does not match the exact Run identity.');
    }

    const effect = run.effects.find((candidate) => candidate.effectId === effectId);
    if (effect === undefined || effect.runId !== runId) {
      throw invariant('The execution input does not match the exact Effect identity.');
    }

    const payload = await this.runs.loadEffectExecutionInput(runId, effectId);
    if (
      payload.runId !== runId
      || payload.effectId !== effectId
      || payload.inputDigest !== effect.inputDigest
    ) {
      throw invariant(
        'The protected Effect input differs from the exact Run, Effect, or input digest.'
      );
    }

    return {
      runId: payload.runId,
      effectId: payload.effectId,
      inputDigest: payload.inputDigest,
      input: payload.input
    };
  }
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
