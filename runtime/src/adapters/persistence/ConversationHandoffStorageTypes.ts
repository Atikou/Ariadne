

export interface ConversationPersistenceClock {
  now(): Date;
}

/** Structural match for the Runtime ShutdownContext without reversing layers. */
export interface ConversationShutdownContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(reserveMs?: number): number;
  throwIfExpired(code?: string): void;
}

export interface ConversationPersistenceFaultInjector {
  beforeCommit?(): void;
  afterCommit?(): void;
}

export class ConversationOutboxClaimError extends Error {
  public constructor(public readonly claimId: string, message: string) {
    super(message);
    this.name = 'ConversationOutboxClaimError';
  }
}

export interface SagaRow {
  saga_id: string;
  version: number;
  session_id: string;
  workspace_id: string;
  message_id: string;
  message_version: number;
  objective_digest: string;
  stage_kind: string;
  saga_json: string;
  created_at: string;
  updated_at: string;
  authoritative_content_digest: string | null;
}

export interface CommandRow {
  command_id: string;
  command_fingerprint: string;
  saga_id: string;
  resulting_version: number;
  result_saga_json: string;
}

export interface EventRow {
  command_id: string;
  saga_id: string;
  saga_version: number;
  event_json: string;
  occurred_at: string;
}

export interface OutboxRow {
  cursor: number;
  message_id: string;
  command_id: string;
  saga_id: string;
  saga_version: number;
  message_kind: string;
  message_json: string;
  created_at: string;
  published_at: string | null;
  published_claim_id: string | null;
  claim_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claim_attempts: number;
  command_fingerprint: string | null;
  result_saga_json: string | null;
}
