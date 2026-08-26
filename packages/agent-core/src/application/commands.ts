import type { AgentRunBinding } from '../domain/run-binding.js';
import type {
  AgentDecisionResolution,
  PermissionDecisionDraft,
  PlanDecisionDraft,
  RecoveryAction
} from '../domain/decision.js';
import type {
  AgentCommandId,
  AgentEffectId,
  AgentInferenceAttemptId,
  AgentTurnId,
  AgentRunId
} from '../domain/values.js';
import type { AgentCommittedDirective } from '../domain/directive.js';
import type { AgentPinnedToolIdentity } from '../domain/tool.js';
import type {
  AgentInferenceRecoveryAction,
  AgentTurnCause,
  AgentTurnInputSummary
} from '../domain/turn.js';

interface AgentCommandBase {
  readonly commandId: AgentCommandId;
  readonly runId: AgentRunId;
  readonly occurredAt: string;
}

interface AgentRunMutationCommandBase extends AgentCommandBase {
  readonly expectedVersion: number;
}

export interface StartAgentRunCommand extends AgentCommandBase {
  readonly kind: 'run.start';
  readonly binding: AgentRunBinding;
}

/** Creates a running Run and its first durable Turn in one version commit. */
export interface AdmitAgentRunCommand extends AgentCommandBase {
  readonly kind: 'run.admit';
  readonly binding: AgentRunBinding;
  readonly turn: {
    readonly cause: Exclude<AgentTurnCause, { readonly kind: 'effect_results' }>;
    readonly turnId: AgentTurnId;
    readonly attemptId: AgentInferenceAttemptId;
    readonly providerIdempotencyKey: string;
    readonly inputDigest: string;
    readonly inputSummary: AgentTurnInputSummary;
  };
}

export interface BeginAgentRunCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.begin';
}

export interface RegisterAgentTurnCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.register_turn';
  readonly turn: {
    readonly cause: AgentTurnCause;
    readonly turnId: AgentTurnId;
    readonly attemptId: AgentInferenceAttemptId;
    readonly providerIdempotencyKey: string;
    readonly inputDigest: string;
    readonly inputSummary: AgentTurnInputSummary;
  };
}

export interface StartAgentInferenceAttemptCommand
extends AgentRunMutationCommandBase {
  readonly kind: 'run.start_inference_attempt';
  readonly turnId: AgentTurnId;
  readonly attemptId: AgentInferenceAttemptId;
}

export type AgentInferenceAttemptResult =
  | {
      readonly status: 'succeeded';
      readonly directive: AgentCommittedDirective;
      readonly directiveDigest: string;
    }
  | {
      /** A deterministic, sanitized Provider rejection known not to produce a directive. */
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly status: 'uncertain';
      readonly reason: string;
      readonly recoveryDecisionId: string;
      readonly allowedActions: readonly AgentInferenceRecoveryAction[];
    }
  | {
      /** Valid only with Provider evidence after an attempt has started. */
      readonly status: 'cancelled';
      readonly reason: string;
      readonly providerCancellationAcknowledgementId: string;
    };

export interface RecordAgentInferenceAttemptResultCommand
extends AgentRunMutationCommandBase {
  readonly kind: 'run.record_inference_attempt_result';
  readonly turnId: AgentTurnId;
  readonly attemptId: AgentInferenceAttemptId;
  readonly recoveryDecisionId?: string;
  readonly result: AgentInferenceAttemptResult;
}

export interface RetryAgentInferenceAttemptCommand
extends AgentRunMutationCommandBase {
  readonly kind: 'run.retry_inference_attempt';
  readonly turnId: AgentTurnId;
  readonly causedByAttemptId: AgentInferenceAttemptId;
  readonly recoveryDecisionId: string;
  readonly attemptId: AgentInferenceAttemptId;
  readonly providerIdempotencyKey: string;
}

export interface RequestAgentDecisionCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.request_decision';
  readonly decision: PermissionDecisionDraft | PlanDecisionDraft;
}

export interface ResolveAgentDecisionCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.resolve_decision';
  readonly resolution: AgentDecisionResolution;
}

export interface RegisterAgentEffectCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.register_effect';
  readonly effect: {
    readonly effectId: AgentEffectId;
    readonly toolCallId: string;
    readonly tool: AgentPinnedToolIdentity;
    readonly idempotencyKey: string;
    readonly capabilityIds: readonly string[];
    readonly scope: readonly string[];
    readonly inputDigest: string;
  };
}

export interface AuthorizeAgentEffectCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.authorize_effect';
  readonly effectId: AgentEffectId;
}

export interface StartAgentEffectCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.start_effect';
  readonly effectId: AgentEffectId;
}

export type AgentEffectResult =
  | {
      readonly status: 'succeeded';
      readonly outputRef?: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly status: 'uncertain';
      readonly reason: string;
      readonly recoveryDecisionId: string;
      readonly allowedActions: readonly RecoveryAction[];
    }
  | {
      readonly status: 'cancelled';
      readonly reason: string;
    };

export interface RecordAgentEffectResultCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.record_effect_result';
  readonly effectId: AgentEffectId;
  readonly result: AgentEffectResult;
}

export interface CompleteAgentRunCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.complete';
  readonly outputRef?: string;
}

export interface FailAgentRunCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.fail';
  readonly errorCode: string;
  readonly message: string;
}

export interface CancelAgentRunCommand extends AgentRunMutationCommandBase {
  readonly kind: 'run.cancel';
  readonly reason: string;
  /** Required only when cancelling an unresolved uncertain inference. */
  readonly recoveryDecisionId?: string;
}

export type AgentRunCommand =
  | AdmitAgentRunCommand
  | StartAgentRunCommand
  | BeginAgentRunCommand
  | RegisterAgentTurnCommand
  | StartAgentInferenceAttemptCommand
  | RecordAgentInferenceAttemptResultCommand
  | RetryAgentInferenceAttemptCommand
  | RequestAgentDecisionCommand
  | ResolveAgentDecisionCommand
  | RegisterAgentEffectCommand
  | AuthorizeAgentEffectCommand
  | StartAgentEffectCommand
  | RecordAgentEffectResultCommand
  | CompleteAgentRunCommand
  | FailAgentRunCommand
  | CancelAgentRunCommand;
