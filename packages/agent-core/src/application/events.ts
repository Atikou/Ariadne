import type { AgentRunState } from '../domain/agent-run.js';
import type { AgentRunBinding } from '../domain/run-binding.js';
import type {
  AgentDecision,
  AgentDecisionResolution
} from '../domain/decision.js';
import type { AgentEffect, AgentEffectState } from '../domain/effect.js';
import type {
  AgentInferenceAttempt,
  AgentInferenceAttemptState,
  AgentTurn
} from '../domain/turn.js';
import type {
  AgentCommandId,
  AgentDecisionId,
  AgentEffectId,
  AgentInferenceAttemptId,
  AgentRunId
} from '../domain/values.js';

export type AgentRunEventPayload =
  | {
      readonly type: 'run.admitted';
      readonly binding: AgentRunBinding;
    }
  | {
      readonly type: 'run.started';
      readonly binding: AgentRunBinding;
    }
  | {
      readonly type: 'run.state_changed';
      readonly from: AgentRunState['status'] | 'absent';
      readonly to: AgentRunState;
    }
  | {
      readonly type: 'turn.registered';
      readonly turn: AgentTurn;
    }
  | {
      readonly type: 'inference_attempt.registered';
      readonly turnId: string;
      readonly attempt: AgentInferenceAttempt;
    }
  | {
      readonly type: 'inference_attempt.transitioned';
      readonly turnId: string;
      readonly attemptId: AgentInferenceAttemptId;
      readonly from: AgentInferenceAttemptState;
      readonly to: AgentInferenceAttemptState;
    }
  | {
      readonly type: 'decision.requested';
      readonly decision: AgentDecision;
    }
  | {
      readonly type: 'decision.resolved';
      readonly decisionId: AgentDecisionId;
      readonly resolution: AgentDecisionResolution;
    }
  | {
      readonly type: 'effect.registered';
      readonly effect: AgentEffect;
    }
  | {
      readonly type: 'effect.transitioned';
      readonly effectId: AgentEffectId;
      readonly from: AgentEffectState;
      readonly to: AgentEffectState;
    }
  | {
      readonly type: 'run.completed';
      readonly outputRef?: string;
    }
  | {
      readonly type: 'run.failed';
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly type: 'run.cancelled';
      readonly reason: string;
    }
  | {
      readonly type: 'plan.version_created';
      readonly planId: string;
      readonly planVersion: number;
      readonly contentHash: string;
    }
  | {
      readonly type: 'plan.approved';
      readonly approvalId: string;
      readonly decisionId: string;
      readonly planId: string;
      readonly planVersion: number;
      readonly contentHash: string;
    }
  | {
      readonly type: 'budget.reserved' | 'budget.settled' | 'budget.released';
      readonly entryId: string;
      readonly reservationId: string;
    }
  | {
      readonly type: 'children.delegated';
      readonly children: readonly {
        readonly delegationId: string;
        readonly childRunId: string;
        readonly childGrantId: string;
        readonly objectiveDigest: string;
        readonly required: boolean;
      }[];
    }
  | {
      readonly type: 'child.terminal_observed';
      readonly delegationId: string;
      readonly childRunId: string;
      readonly childRunVersion: number;
      readonly childStatus: 'completed' | 'failed' | 'cancelled';
    }
  | {
      readonly type: 'run.cancellation_requested';
      readonly reason: string;
    };

export interface AgentRunEvent {
  readonly eventId: string;
  readonly commandId: AgentCommandId;
  readonly runId: AgentRunId;
  readonly runVersion: number;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: AgentRunEventPayload;
}
