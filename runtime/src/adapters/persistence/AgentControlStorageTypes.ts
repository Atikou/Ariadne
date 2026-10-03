import {
  type AgentEffectPayloadCommit,
  type AgentDirectivePayloadCommit,
  type AgentTurnInputPayloadCommit,
  type AgentRunCommitMutation,
  type AgentControlCommitFacts,
  type AgentPlanVersionCommit,
  type AgentBudgetLedgerEntryCommit
} from '@ariadne/agent-core';

export interface AgentPersistenceClock {
  now(): Date;
}

export interface AgentKeyringAnchorVerification {
  readonly generation: number;
  readonly activeKeyId: string;
  readonly availableKeyIds: readonly string[];
  readonly requiredCodecId: string;
}

export interface AgentRunRow {
  run_id: string;
  version: number;
  state_status: string;
  aggregate_json: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCommandRow {
  command_id: string;
  command_digest: string;
  mutation_count: number;
  fact_count: number;
  committed_at: string;
}

export interface AgentPlanVersionRow {
  plan_id: string;
  plan_version: number;
  content_hash: string;
  run_id: string;
  run_version: number;
  command_id: string;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

export interface AgentBudgetGrantRow {
  grant_id: string;
  run_id: string;
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
  deadline_at: string;
  source_kind: 'root' | 'parent_allocation';
  parent_run_id: string | null;
  parent_grant_id: string | null;
  delegation_id: string | null;
  command_id: string;
  run_version: number;
  created_at: string;
}

export interface AgentBudgetEntryRow {
  entry_id: string;
  command_id: string;
  run_id: string;
  run_version: number;
  grant_id: string;
  entry_kind: AgentBudgetLedgerEntryCommit['kind'];
  model_turns: number;
  tool_calls: number;
  read_calls: number;
  write_calls: number;
  shell_calls: number;
  cost_microusd: number;
  reservation_id: string | null;
  delegation_id: string | null;
  child_run_id: string | null;
  child_grant_id: string | null;
  occurred_at: string;
}

export interface AgentDelegationRow {
  delegation_id: string;
  parent_run_id: string;
  child_run_id: string;
  parent_grant_id: string;
  child_grant_id: string;
  objective_digest: string;
  objective_codec_id: string;
  objective_payload_json: string;
  required: number;
  command_id: string;
  parent_run_version: number;
  child_run_version: number;
  created_at: string;
}

export interface AgentChildTerminalRow {
  delegation_id: string;
  parent_run_id: string;
  child_run_id: string;
  child_run_version: number;
  child_status: 'completed' | 'failed' | 'cancelled';
  command_id: string;
  parent_run_version: number;
  observed_at: string;
}

export interface AgentCommandRunRow {
  command_id: string;
  run_id: string;
  ordinal: number;
  expected_version: number | null;
  resulting_version: number;
  result_run_json: string;
}

export interface AgentCommittedMutationRow extends AgentCommandRunRow {
  command_digest: string;
  mutation_count: number;
}

export interface AgentCheckpointRow {
  run_id: string;
  checkpoint_version: number;
  run_version: number;
  command_id: string;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

export type AgentCheckpointMetadataRow = Omit<AgentCheckpointRow, 'codec_id' | 'payload_json'>;

export interface AgentEffectPayloadRow {
  effect_id: string;
  run_id: string;
  input_digest: string;
  input_command_id: string;
  input_run_version: number;
  input_codec_id: string;
  input_payload_json: string;
  result_command_id: string | null;
  result_run_version: number | null;
  result_codec_id: string | null;
  result_payload_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEffectPayloadMetadataRow {
  effect_id: string;
  run_id: string;
  input_digest: string;
  input_command_id: string;
  input_run_version: number;
  result_command_id: string | null;
  result_run_version: number | null;
  has_result: number;
  created_at: string;
  updated_at: string;
}

export interface AgentDirectivePayloadRow {
  artifact_id: string;
  run_id: string;
  command_id: string;
  run_version: number;
  payload_kind: AgentDirectivePayloadCommit['kind'];
  directive_digest: string;
  content_digest: string;
  codec_id: string;
  payload_json: string;
  recorded_at: string;
}

export interface AgentTurnInputPayloadRow {
  run_id: string;
  turn_id: string;
  input_digest: string;
  command_id: string;
  run_version: number;
  codec_id: string;
  payload_json: string;
  created_at: string;
}

export interface AgentControlMetadataRow {
  key: string;
  value: string;
}

export interface ProtectedRecoveryPayloadRow {
  source: string;
  codec_id: string;
  payload_json: string;
}

export interface PreparedPlanVersionFact {
  readonly fact: AgentPlanVersionCommit;
  readonly runVersion: number;
  readonly encoded: PreparedEncodedPayload;
}

export interface PreparedDelegationFact {
  readonly fact: AgentControlCommitFacts['delegations'][number];
  readonly parentRunVersion: number;
  readonly childRunVersion: number;
  readonly encodedObjective: PreparedEncodedPayload;
}

export interface PreparedCommandFacts {
  readonly commandId: string;
  readonly planVersions: readonly PreparedPlanVersionFact[];
  readonly planApprovals: AgentControlCommitFacts['planApprovals'];
  readonly budgetGrants: AgentControlCommitFacts['budgetGrants'];
  readonly budgetEntries: AgentControlCommitFacts['budgetEntries'];
  readonly delegations: readonly PreparedDelegationFact[];
  readonly childTerminals: AgentControlCommitFacts['childTerminals'];
  readonly mutationVersions: ReadonlyMap<string, number>;
}

export interface PreparedEncodedPayload {
  readonly codecId: string;
  readonly payloadJson: string;
}

export interface PreparedEffectArtifact {
  readonly payload: AgentEffectPayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

export interface PreparedDirectiveArtifact {
  readonly payload: AgentDirectivePayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

export interface PreparedTurnInputArtifact {
  readonly payload: AgentTurnInputPayloadCommit;
  readonly encoded: PreparedEncodedPayload;
}

export interface PreparedCommandMutation {
  readonly mutation: AgentRunCommitMutation;
  readonly currentRow: AgentRunRow | undefined;
  readonly checkpoint?: {
    readonly checkpointVersion: number;
    readonly createdAt: string;
    readonly encoded: PreparedEncodedPayload;
  };
  readonly turnInputs: readonly PreparedTurnInputArtifact[];
  readonly effects: readonly PreparedEffectArtifact[];
  readonly directives: readonly PreparedDirectiveArtifact[];
}
