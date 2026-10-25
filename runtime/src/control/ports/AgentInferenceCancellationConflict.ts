/** A live inference has one physical stop owner; another request must retry after it settles. */
export class AgentInferenceCancellationConflictError extends Error {
  public readonly code = 'AGENT_INFERENCE_CANCELLATION_CONFLICT';
  public constructor(public readonly runId: string, operation: 'cancellation' | 'interruption') {
    super(`A different ${operation} already owns this active Agent inference.`);
    this.name = 'AgentInferenceCancellationConflictError';
  }
}
