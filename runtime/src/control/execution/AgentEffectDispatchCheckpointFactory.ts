import type {
  AgentEffectDispatchCheckpointFactory,
  AgentJsonValue,
  AgentRunCheckpointCommit
} from '@ariadne/agent-core';

/** Bounded pure-v3 continuation data; Effect input and result bodies stay protected. */
export class V3AgentEffectDispatchCheckpointFactory
implements AgentEffectDispatchCheckpointFactory {
  public create(
    input: Parameters<AgentEffectDispatchCheckpointFactory['create']>[0]
  ): AgentRunCheckpointCommit {
    const continuation: AgentJsonValue = {
      phase: input.phase,
      effectId: input.effect.effectId,
      inputDigest: input.effect.inputDigest
    };
    return {
      checkpointVersion: input.checkpointVersion,
      createdAt: input.occurredAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: continuation,
        modelContext: null
      }
    };
  }
}
