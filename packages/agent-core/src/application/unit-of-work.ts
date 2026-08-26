import type { AgentRun } from '../domain/agent-run.js';
import type { AgentRunEvent } from './events.js';
import type {
  AgentRunCommitArtifacts,
  AgentTurnInputSnapshotV1
} from './recovery-persistence.js';
import type {
  AgentBudgetSnapshot,
  AgentControlCommitFacts,
  AgentDelegationRecord,
  AgentPlanReference,
  AgentPlanVersionCommit,
  AgentChildTerminalCommit
} from '../domain/plan-budget-delegation.js';

/**
 * One immutable historical AgentRun result owned by a durable command.
 *
 * Mutations in every command are ordered by `runId` using JavaScript code-unit
 * order. The order is part of the durable command result, not presentation.
 */
export interface CommittedAgentRunMutation {
  readonly runId: string;
  readonly resultingVersion: number;
  readonly run: AgentRun;
  readonly events: readonly AgentRunEvent[];
}

export interface CommittedAgentRunCommand {
  readonly commandId: string;
  /** SHA-256 of the canonical command representation. */
  readonly commandDigest: string;
  readonly mutations: readonly CommittedAgentRunMutation[];
}

/**
 * Durable multi-Run identity used by recovery coordinators. The full immutable
 * Run results and events are returned so consumers can fail closed on drift.
 */
export interface AgentRunCommandReceipt {
  readonly commandId: string;
  readonly mutations: readonly CommittedAgentRunMutation[];
}

export interface AgentRunCommandReceiptReader {
  loadCommittedCommandReceipt(
    commandId: string
  ): Promise<AgentRunCommandReceipt | null>;
}

export interface AgentRunCommitMutation extends CommittedAgentRunMutation {
  /**
   * `null` creates a new run. A number updates exactly that persisted version.
   * The implementation must reject any mismatch before its first write.
   */
  readonly expectedVersion: number | null;
  /** Recovery material written in the same transaction as this mutation. */
  readonly artifacts: AgentRunCommitArtifacts;
}

export interface AgentRunCommandCommit {
  readonly commandId: string;
  readonly commandDigest: string;
  /** Non-empty, unique, strict code-unit sorted Run mutations. */
  readonly mutations: readonly AgentRunCommitMutation[];
  /** Cross-Run facts persisted inside the same command transaction. */
  readonly facts?: AgentControlCommitFacts;
}

export interface AgentRunReplayArtifacts {
  readonly runId: string;
  readonly artifacts: AgentRunCommitArtifacts;
}

/**
 * Exact continuation identity a persistence adapter must authorize from its
 * durable, protected Effect-result rows before an `effect_results` Turn can be
 * committed.
 *
 * This is deliberately a request for proof, not proof supplied by the caller:
 * the transaction implementation must reconstruct and compare the authority
 * while it still owns the same atomic read/write boundary as `commitCommand`.
 */
export interface AgentEffectResultContinuationAuthorityCheck {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly resultingVersion: number;
  readonly turnId: string;
  readonly inputDigest: string;
  readonly snapshot: AgentTurnInputSnapshotV1;
}

export interface AgentRunTransaction {
  loadRun(runId: string): Promise<AgentRun | null>;
  loadCommittedCommand(
    commandId: string,
    artifacts?: readonly AgentRunReplayArtifacts[],
    facts?: AgentControlCommitFacts
  ): Promise<CommittedAgentRunCommand | null>;
  loadPlanVersion?(reference: AgentPlanReference): Promise<AgentPlanVersionCommit | null>;
  loadBudgetSnapshot?(grantId: string): Promise<AgentBudgetSnapshot | null>;
  loadDelegationByChild?(childRunId: string): Promise<AgentDelegationRecord | null>;
  listDelegationsByParent?(parentRunId: string): Promise<readonly AgentDelegationRecord[]>;
  loadChildTerminal?(delegationId: string): Promise<AgentChildTerminalCommit | null>;
  /**
   * Proves one newly introduced `effect_results` Turn against durable protected
   * Effect-result authority. Implementations that do not expose this proof are
   * rejected by AgentRunCommandService before its first write.
   */
  assertEffectResultContinuationAuthority?(
    check: AgentEffectResultContinuationAuthorityCheck
  ): Promise<void>;
  /** Atomically persists every mutation or none. */
  commitCommand(commit: AgentRunCommandCommit): Promise<void>;
}

/**
 * Persistence boundary for AgentRun write services.
 *
 * A command commit must validate every version, identity, event, and recovery
 * artifact before the first write, then persist all Run mutations, historical
 * results, events, outbox rows, and artifacts in one transaction.
 */
export interface AgentRunUnitOfWork {
  transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T>;
}
