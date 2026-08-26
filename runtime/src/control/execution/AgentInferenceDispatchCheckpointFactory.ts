import type {
  AgentInferenceDispatchCheckpointFactory,
  AgentInferenceDispatchCheckpointRequest,
  AgentJsonValue,
  AgentRunCheckpointCommit
} from '@ariadne/agent-core';

/** Bounded pure-v3 continuation data; Provider payloads never enter checkpoints. */
export class V3AgentInferenceDispatchCheckpointFactory
implements AgentInferenceDispatchCheckpointFactory {
  public create(
    input: AgentInferenceDispatchCheckpointRequest
  ): AgentRunCheckpointCommit {
    const continuation: AgentJsonValue = input.phase === 'inference_started'
      ? {
          phase: input.phase,
          turnId: input.turn.turnId,
          attemptId: input.attempt.attemptId,
          inputDigest: input.turn.intention.inputDigest,
          providerIdempotencyKey: input.attempt.providerIdempotencyKey
        }
      : {
          phase: input.phase,
          turnId: input.turn.turnId,
          attemptId: input.attempt.attemptId,
          inputDigest: input.turn.intention.inputDigest,
          resultStatus: input.result.status
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
