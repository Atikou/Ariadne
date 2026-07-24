import type { RunKind } from "../core/runTypes.js";

export type RunAggregateStatus =
  | "pending"
  | "running"
  | "blocked"
  | "waiting_confirmation"
  | "waiting_plan_handoff"
  | "paused"
  | "recovery_required"
  | "completed"
  | "failed"
  | "cancelled";

export type RunCheckpointStage =
  | "created"
  | "running"
  | "blocked"
  | "waiting_confirmation"
  | "waiting_plan_handoff"
  | "paused"
  | "recovery_required"
  | "tool_intended"
  | "tool_started"
  | "tool_succeeded"
  | "tool_failed"
  | "tool_cancelled"
  | "completed"
  | "failed"
  | "cancelled"
  | "migrated";

export type RunRecoveryStatus = "none" | "recoverable" | "decision_required";

export interface RunWaitReason {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface InFlightEffect {
  idempotencyKey: string;
  toolName: string;
  status: "intended" | "started";
  resumable: boolean;
}

export interface VerificationEvidence {
  verifier: string;
  status: "passed" | "failed" | "not_verified";
  summary?: string;
  recordedAt: string;
}

export interface RunAggregateState {
  round: number;
  plan: unknown | null;
  childRunIds: string[];
  inFlightEffects: InFlightEffect[];
  verificationEvidence: VerificationEvidence[];
  legacyStatus?: string;
}

export interface RunAggregate {
  id: string;
  kind: RunKind;
  status: RunAggregateStatus;
  aggregateVersion: number;
  sessionId?: string;
  taskId?: string;
  parentRunId?: string;
  triggerId?: string;
  goal?: string;
  checkpointStage: RunCheckpointStage;
  recoveryStatus: RunRecoveryStatus;
  waitReason?: RunWaitReason;
  state: RunAggregateState;
  error?: string;
  result?: unknown;
  correlationId?: string;
  causationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  aggregateVersion: number;
  stage: RunCheckpointStage;
  snapshot: unknown;
  createdAt: string;
}

export type ToolLedgerStatus =
  | "intended"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required";

export interface ToolLedgerEntry {
  idempotencyKey: string;
  runId: string;
  toolName: string;
  toolVersion: string;
  status: ToolLedgerStatus;
  aggregateVersion: number;
  inputHash: string;
  output?: unknown;
  verification?: unknown;
  effects: string[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeDomainEventEnvelope {
  eventId: string;
  cursor: number;
  schemaVersion: "2.0";
  aggregateType: "run";
  aggregateId: string;
  aggregateVersion: number;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  event: {
    kind: string;
    run: RunAggregate;
  };
}

interface ExistingRunCommand {
  runId: string;
  expectedAggregateVersion: number;
  causationId?: string;
}

export type RunCommand =
  | {
      type: "run.create";
      runId?: string;
      kind: RunKind;
      status?: "pending";
      sessionId?: string;
      taskId?: string;
      parentRunId?: string;
      triggerId?: string;
      goal?: string;
      correlationId?: string;
      causationId?: string;
    }
  | (ExistingRunCommand & { type: "run.start" })
  | (ExistingRunCommand & { type: "run.block"; reason: RunWaitReason })
  | (ExistingRunCommand & { type: "run.request_confirmation"; reason: RunWaitReason })
  | (ExistingRunCommand & { type: "run.request_plan_handoff"; reason: RunWaitReason })
  | (ExistingRunCommand & { type: "run.pause"; reason: RunWaitReason })
  | (ExistingRunCommand & {
      type: "run.require_recovery";
      reason: RunWaitReason;
      recoverable: boolean;
    })
  | (ExistingRunCommand & {
      type: "run.tool_intent";
      idempotencyKey: string;
      toolName: string;
      toolVersion: string;
      inputHash: string;
      effects: string[];
      resumable: boolean;
    })
  | (ExistingRunCommand & {
      type: "run.tool_start";
      idempotencyKey: string;
    })
  | (ExistingRunCommand & {
      type: "run.tool_result";
      idempotencyKey: string;
      status: "succeeded" | "failed" | "cancelled";
      output?: unknown;
      verification?: unknown;
    })
  | (ExistingRunCommand & { type: "run.complete"; result: unknown })
  | (ExistingRunCommand & { type: "run.fail"; error: string })
  | (ExistingRunCommand & { type: "run.cancel"; reason?: string });
