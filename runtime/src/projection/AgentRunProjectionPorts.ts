import type {
  AgentPlanReference,
  AgentPlanVersionCommit,
  AgentDirectivePayloadReader,
  AgentRun,
  AgentRunCommandReceiptReader,
  AgentPinnedToolIdentity
} from '@ariadne/agent-core';
import type { PublicToolActivityProjectionV3 } from '@ariadne/protocol/public';

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
  loadDirectivePayload?: AgentDirectivePayloadReader['loadDirectivePayload'];
}

export interface AgentRunInteractionProjectionMessage {
  readonly messageId: string;
  readonly turnId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly occurredAt: string;
}

/** Resolves the protected bodies needed by the public in-Run transcript. */
export interface AgentRunInteractionProjectionResolver {
  resolveInteractionMessages(
    run: AgentRun
  ): Promise<readonly AgentRunInteractionProjectionMessage[]>;
}

/** Resolves only static, contract-pinned public metadata for one exact Tool. */
export interface AgentPublicToolPresentationMetadata {
  readonly kind: NonNullable<
    PublicToolActivityProjectionV3['presentation']
  >['kind'];
  readonly label: string;
}

export interface AgentToolPresentationResolver {
  resolveToolPresentation(
    tool: AgentPinnedToolIdentity
  ): AgentPublicToolPresentationMetadata | null;
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
