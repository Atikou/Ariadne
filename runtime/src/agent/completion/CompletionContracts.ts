import type { AgentStopReason } from "../RunPolicyPrimitives.js";
import type { ToolLedger } from "./ToolLedgerContracts.js";

export type SideEffectKind = "read" | "write" | "shell";

export type CompletionEvidenceKind = "write_readback" | "tool_success" | "manual";

export interface CompletionCriterionInput {
  id: string;
  description: string;
  evidenceKind: CompletionEvidenceKind;
  toolNames?: string[];
  expectedInputSubset?: Record<string, unknown>;
  targetPath?: string;
  afterLastWrite?: boolean;
  required?: boolean;
}

export interface AgentCompletionContext {
  completionCriteria?: CompletionCriterionInput[];
}

export type CompletionRequirement =
  | {
      id: string;
      kind: "side_effect";
      sideEffect: SideEffectKind;
      description: string;
      source: "routing" | "intent" | "workflow";
    }
  | {
      id: string;
      kind: "write_verification";
      description: string;
      source: "workflow";
    }
  | {
      id: string;
      kind: "acceptance";
      description: string;
      evidenceKind: CompletionEvidenceKind;
      toolNames: string[];
      expectedInputSubset?: Record<string, unknown>;
      targetPath?: string;
      afterLastWrite: boolean;
      source: "plan" | "task";
    };

export interface TaskCompletionContract {
  requiresSideEffect: boolean;
  requiredSideEffects: SideEffectKind[];
  source: "routing" | "intent";
  requirements: CompletionRequirement[];
}

export type PersistedTaskCompletionContract = Pick<
  TaskCompletionContract,
  "requiresSideEffect" | "requiredSideEffects"
> &
  Partial<Pick<TaskCompletionContract, "source" | "requirements">>;

export interface CompletionRequirementEvidence {
  requirementId: string;
  kind: CompletionRequirement["kind"];
  satisfied: boolean;
  reason: string;
  toolCallIds: string[];
}

export interface CompletionEvidenceReport {
  satisfied: boolean;
  requirements: CompletionRequirementEvidence[];
  missingRequirementIds: string[];
}

export type CompletionStatus =
  | "completed_success"
  | "completed_partial"
  | "awaiting_permission"
  | "blocked_by_policy"
  | "misleading_completion"
  | "historical_reference";

export interface CompletionGuardResult {
  /** @deprecated Use trustedForMemory. */
  accepted: boolean;
  status: CompletionStatus;
  stopReason: AgentStopReason;
  reason: string;
  contract: TaskCompletionContract;
  ledger: ToolLedger;
  evidence: CompletionEvidenceReport;
  visibleAnswer?: string;
  trustedVisible: boolean;
  trustedForMemory: boolean;
  systemFeedback?: string;
  guardedAnswer?: string;
  rawModelAnswer?: string;
}
