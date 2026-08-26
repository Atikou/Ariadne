export class AgentCoreError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AgentRunInvariantError extends AgentCoreError {
  public constructor(message: string) {
    super('AGENT_RUN_INVARIANT', message);
  }
}

export class AgentRunTransitionError extends AgentCoreError {
  public constructor(message: string) {
    super('AGENT_RUN_TRANSITION', message);
  }
}

export class AgentEffectTransitionError extends AgentCoreError {
  public constructor(message: string) {
    super('AGENT_EFFECT_TRANSITION', message);
  }
}

export class AgentInferenceAttemptTransitionError extends AgentCoreError {
  public constructor(message: string) {
    super('AGENT_INFERENCE_ATTEMPT_TRANSITION', message);
  }
}

export class AgentRunNotFoundError extends AgentCoreError {
  public constructor(runId: string) {
    super('AGENT_RUN_NOT_FOUND', `Agent run "${runId}" does not exist.`);
  }
}

export class AgentRunAlreadyExistsError extends AgentCoreError {
  public constructor(runId: string) {
    super('AGENT_RUN_ALREADY_EXISTS', `Agent run "${runId}" already exists.`);
  }
}

export class AgentRunVersionConflictError extends AgentCoreError {
  public constructor(
    public readonly runId: string,
    public readonly expectedVersion: number | null,
    public readonly actualVersion: number | null
  ) {
    super(
      'AGENT_RUN_VERSION_CONFLICT',
      `Agent run "${runId}" expected version ${String(expectedVersion)}, but found ${String(actualVersion)}.`
    );
  }
}

export class AgentRunCommandConflictError extends AgentCoreError {
  public constructor(
    public readonly commandId: string,
    public readonly committedRunId: string,
    public readonly requestedRunId: string,
    public readonly reason: 'run_mismatch' | 'command_mismatch' = 'run_mismatch'
  ) {
    super(
      'AGENT_RUN_COMMAND_CONFLICT',
      reason === 'command_mismatch'
        ? `Command "${commandId}" was reused with different normalized content for run "${requestedRunId}".`
        : `Command "${commandId}" is already committed for run "${committedRunId}", not "${requestedRunId}".`
    );
  }
}

export class AgentRunRecoveryConflictError extends AgentCoreError {
  public constructor(
    public readonly runId: string,
    public readonly reason:
      | 'checkpoint_mismatch'
      | 'effect_digest_mismatch'
      | 'immutable_payload_conflict',
    message: string
  ) {
    super('AGENT_RUN_RECOVERY_CONFLICT', message);
  }
}

export class AgentRunOutboxClaimConflictError extends AgentCoreError {
  public constructor(
    public readonly claimId: string,
    message: string
  ) {
    super('AGENT_RUN_OUTBOX_CLAIM_CONFLICT', message);
  }
}

export class AgentPersistencePayloadRejectedError extends AgentCoreError {
  public constructor(message: string) {
    super('AGENT_PERSISTENCE_PAYLOAD_REJECTED', message);
  }
}
