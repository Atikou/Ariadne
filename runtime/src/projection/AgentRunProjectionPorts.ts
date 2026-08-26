import type {
  AgentPlanReference,
  AgentPlanVersionCommit,
  AgentRun,
  AgentRunCommandReceiptReader
} from '@ariadne/agent-core';

/**
 * Immutable inputs required to project one exact AgentRun version.
 *
 * The command receipt supplies the complete event set even when the durable
 * outbox leases only part of that version in one page.
 */
export interface AgentRunVersionReader extends AgentRunCommandReceiptReader {
  loadRunVersion(runId: string, version: number): Promise<AgentRun | null>;
  /** Required before production Plan Decision projection may be enabled. */
  loadPlanVersion?(
    reference: AgentPlanReference
  ): Promise<AgentPlanVersionCommit | null>;
}

export interface AgentRunTerminalResultProjectionRequest {
  readonly run: AgentRun;
  readonly sourceRunEventId: string;
  readonly occurredAt: string;
}

export interface AgentRunTerminalResultProjectionSink {
  projectTerminalResult(
    request: AgentRunTerminalResultProjectionRequest
  ): Promise<unknown>;
}
