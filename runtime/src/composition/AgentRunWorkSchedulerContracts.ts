import {
  type AgentRun,
  type ReadyResumableAgentRunRecovery,
  type RecoverableAgentRun
} from '@ariadne/agent-core';
import type { AgentRunWorkClassification } from '../control/execution/AgentRunWorkClassifier.js';
import type { AgentRunRetiredToolCatalogTerminalizationOwner } from '../control/ports/AgentRunAuthorityRetirement.js';

export type StartedWork = Extract<
  AgentRunWorkClassification,
  {
    readonly kind:
      | 'recovery_uncertain_effect'
      | 'recovery_uncertain_inference'
      | 'recovery_uncertain_delegated_inference'
  }
>;

export type ActionableWork = Extract<
  AgentRunWorkClassification,
  {
    readonly kind:
      | 'dispatch_effect'
      | 'continue_effect_results'
      | 'continue_inbox'
      | 'continue_child_results'
      | 'dispatch_follow_up'
      | 'dispatch_delegated_initial'
      | 'fail_model_turn_budget'
      | 'fail_deadline_expired';
  }
>;

export type TerminalizationWork = Extract<
  ActionableWork,
  { readonly kind: 'fail_model_turn_budget' | 'fail_deadline_expired' }
>;

export interface AgentRunWorkEffectDispatchRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly effectId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

/** Structural subset returned by AgentEffectDispatchService. */
export interface AgentRunWorkEffectDispatchReceipt {
  readonly run: {
    readonly runId: string;
    readonly version: number;
  };
  readonly effect: {
    readonly effectId: string;
    readonly state: { readonly status: string };
  };
  readonly status: string;
}

export interface AgentRunWorkEffectDispatcher {
  dispatch(
    request: AgentRunWorkEffectDispatchRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkEffectDispatchReceipt>;
}

/** Structural subset returned by AgentEffectContinuationController. */
export interface AgentRunWorkContinuationReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly replayed: boolean;
}

export interface AgentRunWorkContinuationOwner {
  continueSettledBatch(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkInboxContinuationOwner {
  continueInbox(
    recovery: ReadyResumableAgentRunRecovery,
    inputIds: readonly string[],
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkChildResultsContinuationOwner {
  continueChildResults(
    recovery: ReadyResumableAgentRunRecovery,
    signal: AbortSignal
  ): Promise<AgentRunWorkContinuationReceipt>;
}

export interface AgentRunWorkFollowUpRequest {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly occurredAt: string;
}

export interface AgentRunWorkFollowUpResultIdentity {
  readonly run: { readonly runId: string; readonly version: number };
  readonly turn: { readonly turnId: string };
  readonly attempt: { readonly attemptId: string; readonly state?: { readonly status: string } };
  readonly status?: string;
  readonly recoveryDecisionId?: string;
}

export type AgentRunWorkFollowUpReceipt =
  | {
      readonly status: 'completed';
      readonly inferenceStatus: 'succeeded' | 'failed' | 'cancelled';
      readonly result: AgentRunWorkFollowUpResultIdentity;
    }
  | {
      readonly status: 'waiting_recovery';
      readonly reason:
        | 'inference_outcome_uncertain'
        | 'inference_already_crossed_boundary';
      readonly result?: AgentRunWorkFollowUpResultIdentity;
    };

export interface AgentRunWorkFollowUpOwner {
  dispatchOwned(
    request: AgentRunWorkFollowUpRequest,
    signal: AbortSignal
  ): Promise<AgentRunWorkFollowUpReceipt>;
}

export interface ActiveAgentTurnInterruptionRecovery {
  readonly runId: string;
  readonly runVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly recoveryDecisionId: string;
}

export interface ActiveAgentTurnInterruptionRequest {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly finalize: (
    recovery: ActiveAgentTurnInterruptionRecovery
  ) => Promise<{ readonly runId: string; readonly runVersion: number }>;
}

export type ActiveAgentTurnInterruptionResult =
  | { readonly status: 'not_active' }
  | {
      readonly status: 'interrupted';
      readonly runId: string;
      readonly runVersion: number;
      readonly turnId: string;
      readonly attemptId: string;
      readonly recoveryDecisionId: string;
    }
  | { readonly status: 'already_settled' };

export interface AgentRunWorkTerminalizationReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly status: 'failed';
  readonly reason: 'model_turn_budget_exhausted' | 'deadline_expired';
  readonly errorCode:
    | 'agent_model_turn_budget_exhausted'
    | 'agent_run_deadline_expired';
  readonly replayed: boolean;
}

export interface AgentRunWorkTerminalizationOwner {
  terminalize(
    work: TerminalizationWork,
    signal: AbortSignal
  ): Promise<AgentRunWorkTerminalizationReceipt>;
}

/** Structural subset returned by AgentStartedWorkRecoveryCoordinator. */
export interface AgentRunStartedWorkRecoveryReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly subjectKind: 'effect' | 'inference';
  readonly subjectId: string;
  readonly recoveryDecisionId: string;
  readonly replayed: boolean;
}

export interface AgentRunStartedWorkRecoveryOwner {
  recover(
    work: StartedWork,
    signal: AbortSignal
  ): Promise<AgentRunStartedWorkRecoveryReceipt>;
}

export interface AgentRunWorkSchedulerClock {
  now(): string;
}

export interface AgentRunWorkAuthorityVerifier {
  /**
   * Distinguishes an intentionally retired immutable Catalog from authority
   * corruption. All other unavailable or drifting authority remains an error.
   */
  assessRestorability(
    run: AgentRun,
    signal: AbortSignal
  ): Promise<AgentRunWorkAuthorityAssessment>;
}

export type AgentRunWorkAuthorityAssessment =
  | { readonly status: 'restorable' }
  | { readonly status: 'retired_tool_catalog' };

export interface AgentRunWorkSchedulerOptions {
  readonly intervalMs?: number;
  readonly pageSize?: number;
  readonly maxFixedPointRounds?: number;
  readonly clock?: AgentRunWorkSchedulerClock;
  /** Startup-only. Steady-state started work is always a health fault. */
  readonly startedWorkRecovery?: AgentRunStartedWorkRecoveryOwner;
  readonly authorityVerifier?: AgentRunWorkAuthorityVerifier;
  readonly retiredToolCatalogTerminalizations?:
    AgentRunRetiredToolCatalogTerminalizationOwner;
  readonly delegatedInference?: AgentRunWorkFollowUpOwner;
  /** Provider-routed follow-up owner for durable delegated Child Runs only. */
  readonly delegatedFollowUps?: AgentRunWorkFollowUpOwner;
  readonly childResultsContinuation?: AgentRunWorkChildResultsContinuationOwner;
}

export interface AgentRunWorkDrainResult {
  readonly rounds: number;
  readonly scannedRuns: number;
  readonly dispatchedEffects: number;
  readonly continuedBatches: number;
  readonly continuedInboxInputs: number;
  readonly continuedChildResults: number;
  readonly dispatchedFollowUps: number;
  readonly dispatchedDelegatedInitials: number;
  readonly terminalizedRuns: number;
}

export interface AgentRunWorkSchedulerFault {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly kind:
    | 'blocked_recovery'
    | 'unsupported'
    | 'health_fault'
    | 'recovery_uncertain_effect'
    | 'recovery_uncertain_inference'
    | 'recovery_uncertain_delegated_inference';
  readonly reason: string;
}

export class AgentRunWorkSchedulerHealthError extends Error {
  public readonly code = 'AGENT_RUN_WORK_SCHEDULER_UNHEALTHY';

  public constructor(public readonly faults: readonly AgentRunWorkSchedulerFault[]) {
    super('One or more active Agent Runs have no safe production work owner.');
    this.name = 'AgentRunWorkSchedulerHealthError';
  }
}

export class AgentRunWorkSchedulerShutdownError extends Error {
  public readonly code = 'AGENT_RUN_WORK_SCHEDULER_SHUTDOWN_DEADLINE_EXCEEDED';

  public constructor() {
    super('Agent Run work scheduler did not join active work before shutdown deadline.');
    this.name = 'AgentRunWorkSchedulerShutdownError';
  }
}

export interface ScannedRun {
  readonly recovery: RecoverableAgentRun;
  readonly work: AgentRunWorkClassification | null;
}

export interface ScanRound {
  readonly runs: readonly ScannedRun[];
}

export interface PendingActiveInterruption {
  readonly request: ActiveAgentTurnInterruptionRequest;
  readonly result: Promise<ActiveAgentTurnInterruptionResult>;
  readonly resolve: (result: ActiveAgentTurnInterruptionResult) => void;
  readonly reject: (error: unknown) => void;
}

export interface ActiveInferenceDispatch {
  readonly expectedVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly controller: AbortController;
  interruption: PendingActiveInterruption | null;
}

export interface MutableAgentRunWorkDrainResult {
  rounds: number;
  scannedRuns: number;
  dispatchedEffects: number;
  continuedBatches: number;
  continuedInboxInputs: number;
  continuedChildResults: number;
  dispatchedFollowUps: number;
  dispatchedDelegatedInitials: number;
  terminalizedRuns: number;
}
