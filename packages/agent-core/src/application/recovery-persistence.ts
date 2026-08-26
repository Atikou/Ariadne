import { isTerminalAgentRun, type AgentRun } from '../domain/agent-run.js';
import {
  AgentRunInvariantError,
  AgentRunRecoveryConflictError
} from '../domain/errors.js';
import type { AgentRunEvent } from './events.js';
import { isCanonicalIsoTimestamp } from '../domain/values.js';
import type { AgentJsonValue } from '../domain/json-value.js';
import type { AgentEffect } from '../domain/effect.js';
import { assertValidAgentAvailableTool, type AgentAvailableTool } from '../domain/tool.js';
import { assertValidAgentTurnCause, type AgentTurnCause } from '../domain/turn.js';
import type { AgentTurnInputMessage } from './agent-engine.js';
import {
  canonicalizeAgentTurnInput,
  digestAgentTurnInput,
  summarizeAgentTurnInput
} from './turn-input-digest.js';
import { canonicalizeAgentControlData } from './control-command-digest.js';

export const MAX_PROTECTED_AGENT_TURN_INPUT_SNAPSHOT_UTF8_BYTES = 256 * 1_024;

export interface AgentRunCheckpointPayload
extends Readonly<Record<string, AgentJsonValue>> {
  readonly format: 'ariadne.agent-checkpoint';
  readonly schemaVersion: 1;
  readonly engineContinuation: AgentJsonValue;
  readonly modelContext: AgentJsonValue;
}

export interface AgentRunCheckpointCommit {
  readonly checkpointVersion: number;
  readonly payload: AgentRunCheckpointPayload;
  readonly createdAt: string;
}

export type AgentEffectPayloadCommit =
  | {
      readonly kind: 'record_input';
      readonly effectId: string;
      readonly inputDigest: string;
      readonly input: AgentJsonValue;
      readonly recordedAt: string;
    }
  | {
      readonly kind: 'record_result';
      readonly effectId: string;
      readonly inputDigest: string;
      readonly result: AgentJsonValue;
      readonly recordedAt: string;
    };

export interface AgentDirectivePayloadCommit {
  readonly artifactId: string;
  readonly kind:
    | 'response_content'
    | 'checkpoint_reason'
    | 'completion_output'
    | 'failure_message';
  readonly directiveDigest: string;
  readonly contentDigest: string;
  readonly payload: AgentJsonValue;
  readonly recordedAt: string;
}

export type AgentTurnInputAuthorityReference =
  | {
      readonly kind: 'conversation_message';
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly messageId: string;
      readonly messageVersion: number;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'parent_delegation';
      readonly parentRunId: string;
      readonly delegationId: string;
      readonly objectiveDigest: string;
    };

export interface AgentTurnInputSnapshotV1 {
  readonly format: 'ariadne.agent-turn-input';
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly turnId: string;
  readonly cause: AgentTurnCause;
  readonly authorityRef: AgentTurnInputAuthorityReference;
  readonly messages: readonly AgentTurnInputMessage[];
  readonly availableTools: readonly AgentAvailableTool[];
}

/**
 * Evidence assembled by a persistence adapter after it has loaded the exact
 * protected Effect-result rows referenced by an AgentRun.  Cancellation has
 * no protected result row: its evidence is explicitly sourced from the
 * sanitized aggregate state instead.
 *
 * Core validates this value purely.  The adapter remains responsible for
 * proving that every `protected_result` value came from the durable row whose
 * AAD/reference it already authenticated.
 */
export type AgentTerminalEffectResultEvidence =
  | {
      readonly kind: 'protected_result';
      readonly runId: string;
      readonly effectId: string;
      readonly toolCallId: string;
      readonly inputDigest: string;
      readonly status: 'succeeded' | 'failed';
      readonly result: AgentJsonValue;
    }
  | {
      readonly kind: 'aggregate_cancelled';
      readonly runId: string;
      readonly effectId: string;
      readonly toolCallId: string;
      readonly inputDigest: string;
      readonly status: 'cancelled';
      readonly reason: string;
    };

export const MAX_SANITIZED_AGENT_EFFECT_CANCELLATION_REASON_CHARACTERS = 256;
export const AGENT_EFFECT_CANCELLATION_RESULT_FORMAT =
  'ariadne.effect-cancellation' as const;

export interface AgentTurnInputPayloadCommit {
  readonly turnId: string;
  readonly inputDigest: string;
  readonly payload: AgentTurnInputSnapshotV1;
  readonly recordedAt: string;
}

/**
 * Recovery material committed with one aggregate transition.
 *
 * This type deliberately contains JSON values rather than provider objects,
 * request headers, or process-local handles.
 */
export interface AgentRunCommitArtifacts {
  readonly checkpoint?: AgentRunCheckpointCommit;
  readonly turnInputPayloads: readonly AgentTurnInputPayloadCommit[];
  readonly effectPayloads: readonly AgentEffectPayloadCommit[];
  readonly directivePayloads?: readonly AgentDirectivePayloadCommit[];
}

export interface AgentPersistencePayloadContext {
  readonly kind:
    | 'checkpoint'
    | 'turn_input'
    | 'effect_input'
    | 'effect_result'
    | 'plan_payload'
    | 'delegation_objective'
    | 'directive_response';
  readonly runId: string;
  /** AAD: exact aggregate/command identity that owns this payload. */
  readonly commandId: string;
  readonly runVersion: number;
  readonly checkpointVersion?: number;
  readonly turnId?: string;
  readonly effectId?: string;
  readonly inputDigest?: string;
  readonly planId?: string;
  readonly planVersion?: number;
  readonly contentHash?: string;
  readonly delegationId?: string;
  readonly objectiveDigest?: string;
  readonly directiveDigest?: string;
}

export interface EncodedAgentPersistencePayload {
  /** Stable codec/key-version identifier stored beside the encoded payload. */
  readonly codecId: string;
  /** Must remain JSON serializable; encrypted codecs can return a JSON envelope. */
  readonly payload: AgentJsonValue;
}

/**
 * Security boundary for recovery payloads.
 *
 * Implementations may reject, redact, or encrypt sensitive material. `decode`
 * receives the persisted codec id so a key-ring implementation can support
 * rotation without silently decoding with the wrong key.
 */
export interface AgentPersistencePayloadCodec {
  encode(
    value: AgentJsonValue,
    context: AgentPersistencePayloadContext
  ): EncodedAgentPersistencePayload;
  decode(
    encoded: EncodedAgentPersistencePayload,
    context: AgentPersistencePayloadContext
  ): AgentJsonValue;
}

export interface AgentRunCheckpoint {
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly payload: AgentRunCheckpointPayload;
  readonly createdAt: string;
}

export interface AgentEffectPayload {
  readonly runId: string;
  readonly effectId: string;
  readonly inputDigest: string;
  readonly input: AgentJsonValue;
  readonly result?: AgentJsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentDirectivePayloadReference {
  readonly artifactId: string;
  readonly kind: AgentDirectivePayloadCommit['kind'];
  readonly directiveDigest: string;
  readonly contentDigest: string;
  readonly commandId: string;
  readonly runVersion: number;
  readonly recordedAt: string;
}

/**
 * Minimum immutable identity needed by an authorized adapter consumer to
 * resolve one protected Directive body. Persistence-owned command/version/AAD
 * metadata is loaded from the row and verified before the payload is returned.
 */
export interface AgentDirectivePayloadLookup {
  readonly runId: string;
  readonly artifactId: string;
  readonly kind: AgentDirectivePayloadCommit['kind'];
  readonly directiveDigest: string;
  readonly contentDigest: string;
}

export interface AgentDirectivePayloadReader {
  loadDirectivePayload(reference: AgentDirectivePayloadLookup): Promise<AgentJsonValue>;
}

export interface AgentRunCheckpointReference {
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly commandId: string;
  readonly createdAt: string;
}

export interface AgentTurnInputPayloadReference {
  readonly runId: string;
  readonly turnId: string;
  readonly inputDigest: string;
  readonly commandId: string;
  readonly runVersion: number;
  readonly createdAt: string;
}

export interface AgentTurnInputPayloadLookup {
  readonly runId: string;
  readonly turnId: string;
  readonly inputDigest: string;
}

export interface AgentTurnInputPayloadReader {
  loadTurnInputPayload(
    reference: AgentTurnInputPayloadLookup | AgentTurnInputPayloadReference
  ): Promise<AgentTurnInputSnapshotV1>;
}

interface AgentEffectPayloadReferenceBase {
  readonly runId: string;
  readonly effectId: string;
  readonly inputDigest: string;
  readonly inputCommandId: string;
  readonly inputRunVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentEffectPayloadReference =
  | (AgentEffectPayloadReferenceBase & {
      readonly hasResult: false;
    })
  | (AgentEffectPayloadReferenceBase & {
      readonly hasResult: true;
      readonly resultCommandId: string;
      readonly resultRunVersion: number;
    });

export interface ReadyQueuedAgentRunRecovery {
  readonly ready: true;
  readonly phase: 'queued';
  readonly run: AgentRun;
  readonly checkpoint: null;
  readonly effectPayloads: readonly [];
  readonly turnInputPayloads: readonly [];
}

export interface ReadyResumableAgentRunRecovery {
  readonly ready: true;
  readonly phase: 'resumable';
  readonly run: AgentRun;
  readonly checkpoint: AgentRunCheckpointReference;
  readonly turnInputPayloads: readonly AgentTurnInputPayloadReference[];
  readonly effectPayloads: readonly AgentEffectPayloadReference[];
}

export interface BlockedAgentRunRecovery {
  readonly ready: false;
  readonly run: AgentRun;
  readonly issues: readonly (
    | 'missing_checkpoint'
    | 'unexpected_checkpoint'
    | 'checkpoint_metadata_mismatch'
    | 'missing_effect_input'
    | 'effect_digest_mismatch'
    | 'missing_effect_result'
    | 'unexpected_effect_result'
    | 'missing_budget_grant'
    | 'budget_integrity_mismatch'
    | 'missing_plan_payload'
    | 'plan_integrity_mismatch'
    | 'missing_delegation'
    | 'delegation_integrity_mismatch'
    | 'pending_required_child_mismatch'
    | 'missing_directive_payload'
    | 'directive_payload_mismatch'
    | 'missing_turn_input'
    | 'unexpected_turn_input'
    | 'turn_input_digest_mismatch'
    | 'turn_input_cause_mismatch'
    | 'turn_input_catalog_mismatch'
  )[];
}

export type RecoverableAgentRun =
  | ReadyQueuedAgentRunRecovery
  | ReadyResumableAgentRunRecovery
  | BlockedAgentRunRecovery;

export interface AgentRunRecoveryCursor {
  readonly createdAt: string;
  readonly runId: string;
}

export interface AgentRunRecoveryQueryRequest {
  readonly limit?: number;
  readonly after?: AgentRunRecoveryCursor;
}

export interface AgentRunRecoveryPage {
  readonly items: readonly RecoverableAgentRun[];
  readonly nextCursor?: AgentRunRecoveryCursor;
}

export interface AgentRunRecoveryQuery {
  listActiveRuns(
    request?: AgentRunRecoveryQueryRequest
  ): Promise<AgentRunRecoveryPage>;
}

/** Payloads are decoded only after the recovery coordinator selects a run. */
export interface AgentRunRecoveryPayloadReader {
  loadCheckpoint(
    reference: AgentRunCheckpointReference
  ): Promise<AgentRunCheckpoint>;
  loadEffectInput(
    reference: AgentEffectPayloadReference
  ): Promise<Omit<AgentEffectPayload, 'result'>>;
  loadEffectResult(
    reference: AgentEffectPayloadReference & { readonly hasResult: true }
  ): Promise<AgentJsonValue>;
  loadTurnInputPayload(
    reference: AgentTurnInputPayloadLookup | AgentTurnInputPayloadReference
  ): Promise<AgentTurnInputSnapshotV1>;
}

export interface AgentRunOutboxClaimRequest {
  readonly claimId: string;
  readonly leaseMs: number;
  readonly limit: number;
}

export interface ClaimedAgentRunOutboxMessage {
  readonly cursor: number;
  readonly eventId: string;
  readonly claimId: string;
  readonly leaseExpiresAt: string;
  readonly event: AgentRunEvent;
  readonly createdAt: string;
  readonly publishAttempts: number;
}

export interface AgentRunOutboxPublishRequest {
  readonly claimId: string;
  readonly messages: readonly {
    readonly cursor: number;
    readonly eventId: string;
  }[];
}

export interface AgentRunOutboxStore {
  claimPending(
    request: AgentRunOutboxClaimRequest
  ): Promise<readonly ClaimedAgentRunOutboxMessage[]>;
  markPublished(request: AgentRunOutboxPublishRequest): Promise<void>;
}

/** Enforces that a transition cannot create an unrecoverable durable run. */
export function assertAgentRunCommitArtifacts(
  current: AgentRun | null,
  next: AgentRun,
  artifacts: AgentRunCommitArtifacts
): void {
  assertExactTurnInputArtifacts(current, next, artifacts.turnInputPayloads);
  const checkpoint = artifacts.checkpoint;
  if (next.state.status === 'queued') {
    if (checkpoint !== undefined) {
      throw checkpointConflict(next.runId, 'A queued run must not persist checkpoint zero.');
    }
  } else if (isTerminalAgentRun(next)) {
    if (checkpoint !== undefined) assertExactCheckpoint(next, checkpoint);
  } else if (isAgentRunInboxOnlyMutation(current, next)) {
    if (checkpoint !== undefined) {
      throw checkpointConflict(
        next.runId,
        'A pure Agent inbox mutation must reuse the existing recovery checkpoint.'
      );
    }
  } else {
    if (checkpoint === undefined) {
      throw checkpointConflict(
        next.runId,
        'A running, waiting, or recovering run requires an exact recovery checkpoint.'
      );
    }
    assertExactCheckpoint(next, checkpoint);
  }

  const expected = new Map<string, 'record_input' | 'record_result'>();
  const currentEffects = new Map(
    (current?.effects ?? []).map((effect) => [effect.effectId, effect] as const)
  );
  for (const effect of next.effects) {
    const previous = currentEffects.get(effect.effectId);
    if (previous === undefined) {
      expected.set(effect.effectId, 'record_input');
      continue;
    }
    const becameKnownResult =
      previous.state.status !== 'succeeded'
      && previous.state.status !== 'failed'
      && (effect.state.status === 'succeeded' || effect.state.status === 'failed');
    if (becameKnownResult) expected.set(effect.effectId, 'record_result');
  }

  const seen = new Set<string>();
  for (const payload of artifacts.effectPayloads) {
    if (seen.has(payload.effectId)) {
      throw new AgentRunInvariantError(
        'One command cannot persist multiple recovery mutations for the same effect.'
      );
    }
    seen.add(payload.effectId);
    if (expected.get(payload.effectId) !== payload.kind) {
      throw new AgentRunRecoveryConflictError(
        next.runId,
        'immutable_payload_conflict',
        `Effect payload "${payload.effectId}" does not belong to this transition.`
      );
    }
    const effect = next.effects.find((candidate) => candidate.effectId === payload.effectId);
    if (effect === undefined || effect.inputDigest !== payload.inputDigest) {
      throw new AgentRunRecoveryConflictError(
        next.runId,
        'effect_digest_mismatch',
        `Effect payload "${payload.effectId}" does not match the committed effect digest.`
      );
    }
    if (!isTimestamp(payload.recordedAt)) {
      throw new AgentRunInvariantError('Effect recovery timestamps must be valid ISO timestamps.');
    }
    assertJsonValue(
      payload.kind === 'record_input' ? payload.input : payload.result,
      `effectPayloads.${payload.effectId}`
    );
  }

  if (seen.size !== expected.size || [...expected.keys()].some((id) => !seen.has(id))) {
    throw new AgentRunRecoveryConflictError(
      next.runId,
      'immutable_payload_conflict',
      'The command must persist exactly the recovery payloads introduced by its transition.'
    );
  }


  const previousDirectiveArtifacts = collectDirectiveArtifactReferences(current);
  const nextDirectiveArtifacts = collectDirectiveArtifactReferences(next);
  const expectedDirectiveArtifacts = new Map(
    [...nextDirectiveArtifacts].filter(([artifactId]) =>
      !previousDirectiveArtifacts.has(artifactId)
    )
  );
  const seenDirectiveArtifacts = new Set<string>();
  for (const payload of artifacts.directivePayloads ?? []) {
    if (seenDirectiveArtifacts.has(payload.artifactId)) {
      throw new AgentRunInvariantError(
        'One command cannot persist a Directive artifact more than once.'
      );
    }
    seenDirectiveArtifacts.add(payload.artifactId);
    const reference = expectedDirectiveArtifacts.get(payload.artifactId);
    if (
      reference === undefined
      || reference.kind !== payload.kind
      || reference.directiveDigest !== payload.directiveDigest
      || reference.contentDigest !== payload.contentDigest
      || !isTimestamp(payload.recordedAt)
    ) {
      throw new AgentRunRecoveryConflictError(
        next.runId,
        'immutable_payload_conflict',
        'Directive payload must match the exact newly committed protected reference.'
      );
    }
    assertJsonValue(payload.payload, `directivePayloads.${payload.artifactId}`);
  }
  if (
    seenDirectiveArtifacts.size !== expectedDirectiveArtifacts.size
    || [...expectedDirectiveArtifacts.keys()].some(
      (artifactId) => !seenDirectiveArtifacts.has(artifactId)
    )
  ) {
    throw new AgentRunRecoveryConflictError(
      next.runId,
      'immutable_payload_conflict',
      'Every newly committed untrusted Directive body requires one protected artifact.'
    );
  }
}

export function isAgentRunInboxOnlyMutation(
  current: AgentRun | null,
  next: AgentRun
): boolean {
  return current !== null
    && next.version === current.version + 1
    && next.state.checkpointVersion === current.state.checkpointVersion
    && canonicalizeAgentControlData(next.binding)
      === canonicalizeAgentControlData(current.binding)
    && canonicalizeAgentControlData(next.state)
      === canonicalizeAgentControlData(current.state)
    && canonicalizeAgentControlData(next.turns)
      === canonicalizeAgentControlData(current.turns)
    && canonicalizeAgentControlData(next.effects)
      === canonicalizeAgentControlData(current.effects)
    && canonicalizeAgentControlData(next.inbox)
      !== canonicalizeAgentControlData(current.inbox);
}

/** Rehashes protected Turn inputs before a Unit of Work performs its first write. */
export async function assertAgentRunCommitArtifactDigests(
  current: AgentRun | null,
  next: AgentRun,
  artifacts: AgentRunCommitArtifacts
): Promise<void> {
  assertAgentRunCommitArtifacts(current, next, artifacts);
  const introduced = new Map(
    next.turns
      .filter((turn) => !current?.turns.some((candidate) => candidate.turnId === turn.turnId))
      .map((turn) => [turn.turnId, turn] as const)
  );
  for (const commit of artifacts.turnInputPayloads) {
    const turn = introduced.get(commit.turnId);
    if (turn === undefined) throw turnInputConflict(next.runId, 'unexpected_turn_input');
    const actual = await digestAgentTurnInput({
      messages: commit.payload.messages,
      availableTools: commit.payload.availableTools
    });
    if (actual !== commit.inputDigest || actual !== turn.intention.inputDigest) {
      throw turnInputConflict(next.runId, 'turn_input_digest_mismatch');
    }
  }
}

/** Validates one decoded immutable snapshot against its exact historical Turn. */
export async function assertAgentTurnInputSnapshotMatchesTurn(
  run: AgentRun,
  turnId: string,
  inputDigest: string,
  snapshot: AgentTurnInputSnapshotV1
): Promise<void> {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined || turn.intention.inputDigest !== inputDigest) {
    throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
  }
  assertExactTurnInputSnapshot(run, turnId, snapshot);
  const modelData = {
    messages: snapshot.messages,
    availableTools: snapshot.availableTools
  };
  const summary = summarizeAgentTurnInput(modelData);
  const actualDigest = await digestAgentTurnInput(modelData);
  if (!sameTurnCause(snapshot.cause, turn.intention.cause)) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  if (
    actualDigest !== inputDigest
    || summary.messageCount !== turn.intention.inputSummary.messageCount
    || summary.toolCount !== turn.intention.inputSummary.toolCount
    || summary.contentCharacterCount !== turn.intention.inputSummary.contentCharacterCount
  ) {
    throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
  }
}

/**
 * Verifies every structured result in one cumulative Turn snapshot against
 * evidence supplied by the durable-result adapter.  This function performs no
 * I/O and therefore never claims that a body is durable by itself.
 */
export function assertAgentTurnInputSnapshotMatchesTerminalEffectEvidence(
  run: AgentRun,
  turnId: string,
  snapshot: AgentTurnInputSnapshotV1,
  evidence: readonly AgentTerminalEffectResultEvidence[]
): void {
  assertExactTurnInputSnapshot(run, turnId, snapshot);
  if (!Array.isArray(evidence)) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  const expected = expectedEffectResultsForTurn(run, turnId);
  const messages = structuredEffectResults(snapshot);
  if (evidence.length !== expected.length || messages.length !== expected.length) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  const seenEffectIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  for (const [index, expectedResult] of expected.entries()) {
    const proof = evidence[index];
    const message = messages[index];
    if (
      proof === undefined
      || message === undefined
      || seenEffectIds.has(proof.effectId)
      || seenToolCallIds.has(proof.toolCallId)
      || proof.runId !== run.runId
      || proof.effectId !== expectedResult.effect.effectId
      || proof.toolCallId !== expectedResult.effect.toolCallId
      || proof.inputDigest !== expectedResult.effect.inputDigest
      || proof.status !== expectedResult.status
      || message.effectId !== proof.effectId
      || message.toolCallId !== proof.toolCallId
      || message.status !== proof.status
    ) {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    seenEffectIds.add(proof.effectId);
    seenToolCallIds.add(proof.toolCallId);
    if (proof.kind === 'protected_result') {
      if (
        !isExactDataObject(proof, [
          'kind',
          'runId',
          'effectId',
          'toolCallId',
          'inputDigest',
          'status',
          'result'
        ])
        || (proof.status !== 'succeeded' && proof.status !== 'failed')
      ) {
        throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
      }
      try {
        canonicalizeAgentTurnInput({
          messages: [{
            kind: 'effect_result',
            effectId: proof.effectId,
            toolCallId: proof.toolCallId,
            status: proof.status,
            result: proof.result
          }],
          availableTools: []
        });
      } catch {
        throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
      }
      if (canonicalizeJsonData(proof.result) !== canonicalizeJsonData(message.result)) {
        throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
      }
      continue;
    }
    if (
      proof.kind !== 'aggregate_cancelled'
      || !isExactDataObject(proof, [
        'kind',
        'runId',
        'effectId',
        'toolCallId',
        'inputDigest',
        'status',
        'reason'
      ])
      || proof.status !== 'cancelled'
      || expectedResult.status !== 'cancelled'
      || proof.reason !== expectedResult.cancellationReason
    ) {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    assertSanitizedAgentEffectCancellationReason(proof.reason);
    if (!isExactCancelledResult(message.result, proof.reason)) {
      throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
    }
  }
}

/** Cancellation reaches the model only as a bounded aggregate reason code. */
export function assertSanitizedAgentEffectCancellationReason(reason: string): void {
  if (
    typeof reason !== 'string'
    || reason.length < 1
    || reason.length > MAX_SANITIZED_AGENT_EFFECT_CANCELLATION_REASON_CHARACTERS
    || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(reason)
  ) {
    throw new AgentRunInvariantError(
      'Cancelled Effect continuation reasons must be bounded sanitized reason codes.'
    );
  }
}

/** Exact synthetic protected result used when cancellation has no result row. */
export function createAgentEffectCancellationResult(
  reason: string
): AgentJsonValue {
  assertSanitizedAgentEffectCancellationReason(reason);
  return {
    kind: AGENT_EFFECT_CANCELLATION_RESULT_FORMAT,
    schemaVersion: 1,
    reason
  };
}

function assertExactTurnInputArtifacts(
  current: AgentRun | null,
  next: AgentRun,
  commits: readonly AgentTurnInputPayloadCommit[]
): void {
  const previousTurnIds = new Set((current?.turns ?? []).map((turn) => turn.turnId));
  const introduced = new Map(
    next.turns
      .filter((turn) => !previousTurnIds.has(turn.turnId))
      .map((turn) => [turn.turnId, turn] as const)
  );
  const seen = new Set<string>();
  for (const commit of commits) {
    const turn = introduced.get(commit.turnId);
    if (turn === undefined || seen.has(commit.turnId)) {
      throw turnInputConflict(next.runId, 'unexpected_turn_input');
    }
    seen.add(commit.turnId);
    if (
      commit.inputDigest !== turn.intention.inputDigest
      || commit.recordedAt !== turn.createdAt
    ) {
      throw turnInputConflict(next.runId, 'turn_input_digest_mismatch');
    }
    assertExactTurnInputSnapshot(next, turn.turnId, commit.payload);
    const summary = summarizeAgentTurnInput({
      messages: commit.payload.messages,
      availableTools: commit.payload.availableTools
    });
    if (
      summary.messageCount !== turn.intention.inputSummary.messageCount
      || summary.toolCount !== turn.intention.inputSummary.toolCount
      || summary.contentCharacterCount !== turn.intention.inputSummary.contentCharacterCount
    ) {
      throw turnInputConflict(next.runId, 'turn_input_digest_mismatch');
    }
    if (!sameTurnCause(commit.payload.cause, turn.intention.cause)) {
      throw turnInputConflict(next.runId, 'turn_input_cause_mismatch');
    }
  }
  if (seen.size !== introduced.size) {
    throw turnInputConflict(next.runId, 'missing_turn_input');
  }
}

function assertExactTurnInputSnapshot(
  run: AgentRun,
  turnId: string,
  snapshot: AgentTurnInputSnapshotV1
): void {
  if (
    !isExactDataObject(snapshot, [
      'format',
      'schemaVersion',
      'runId',
      'turnId',
      'cause',
      'authorityRef',
      'messages',
      'availableTools'
    ])
    || snapshot.format !== 'ariadne.agent-turn-input'
    || snapshot.schemaVersion !== 1
    || snapshot.runId !== run.runId
    || snapshot.turnId !== turnId
  ) {
    throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
  }
  try {
    assertValidAgentTurnCause(snapshot.cause);
    canonicalizeAgentTurnInput({
      messages: snapshot.messages,
      availableTools: snapshot.availableTools
    });
  } catch {
    throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
  }
  if (!authorityMatchesBinding(snapshot.authorityRef, run)) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  const grantedCapabilityIds = new Set(
    run.binding.capabilities.map((grant) => grant.capabilityId)
  );
  for (const [index, available] of snapshot.availableTools.entries()) {
    try {
      assertValidAgentAvailableTool(available, `turnInput.availableTools[${String(index)}]`);
    } catch {
      throw turnInputConflict(run.runId, 'turn_input_catalog_mismatch');
    }
    if (
      available.tool.catalogId !== run.binding.toolCatalog.catalogId
      || available.tool.revision !== run.binding.toolCatalog.revision
      || available.tool.digest !== run.binding.toolCatalog.digest
      || !run.binding.toolCatalog.allowedToolNames.includes(available.tool.toolName)
      || available.capabilityIds.some((id) => !grantedCapabilityIds.has(id))
    ) {
      throw turnInputConflict(run.runId, 'turn_input_catalog_mismatch');
    }
  }
  if (
    snapshot.availableTools.length !== run.binding.toolCatalog.allowedToolNames.length
    || snapshot.availableTools.some((available, index) => (
      available.tool.toolName !== run.binding.toolCatalog.allowedToolNames[index]
    ))
  ) {
    throw turnInputConflict(run.runId, 'turn_input_catalog_mismatch');
  }
  const effectResults = structuredEffectResults(snapshot);
  const expectedEffectResults = expectedEffectResultsForTurn(run, turnId);
  if (
    effectResults.length !== expectedEffectResults.length
    || effectResults.some((result, index) => {
      const expected = expectedEffectResults[index];
      return expected === undefined
        || result.effectId !== expected.effect.effectId
        || result.toolCallId !== expected.effect.toolCallId
        || result.status !== expected.status
        || (
          result.status === 'cancelled'
          && (
            expected.status !== 'cancelled'
            || !isExactCancelledResult(result.result, expected.cancellationReason)
          )
        );
    })
  ) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  assertExactCurrentContinuationSuffix(run, turnId, snapshot.messages);
  if (
    new TextEncoder().encode(canonicalizeJsonData(snapshot)).byteLength
    > MAX_PROTECTED_AGENT_TURN_INPUT_SNAPSHOT_UTF8_BYTES
  ) {
    throw turnInputConflict(run.runId, 'turn_input_digest_mismatch');
  }
}

function assertExactCurrentContinuationSuffix(
  run: AgentRun,
  turnId: string,
  messages: readonly AgentTurnInputMessage[]
): void {
  const turn = run.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  const cause = turn.intention.cause;
  if (cause.kind === 'conversation_objective' || cause.kind === 'delegation_objective') return;

  const inputIds = cause.kind === 'inbox_inputs'
    ? cause.inputIds
    : cause.kind === 'effect_results'
      ? cause.inboxInputIds ?? []
      : [];
  const inputMessages = messages.slice(messages.length - inputIds.length);
  if (
    inputMessages.length !== inputIds.length
    || inputMessages.some((message, index) => {
      const input = run.inbox.find((candidate) => candidate.inputId === inputIds[index]);
      return input === undefined
        || input.state !== 'claimed'
        || input.claimedTurnId !== turnId
        || message.kind !== 'text'
        || message.role !== 'user'
        || message.content !== input.content;
    })
  ) throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');

  const beforeInputs = messages.length - inputIds.length;
  if (cause.kind === 'inbox_inputs') {
    const assistant = messages[beforeInputs - 1];
    if (assistant?.kind !== 'text' || assistant.role !== 'assistant') {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    return;
  }
  if (cause.kind === 'child_results') {
    const assistant = messages[beforeInputs - 2];
    const childResults = messages[beforeInputs - 1];
    if (
      assistant?.kind !== 'text'
      || assistant.role !== 'assistant'
      || childResults?.kind !== 'text'
      || childResults.role !== 'user'
    ) {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    return;
  }

  const currentResults = messages.slice(
    beforeInputs - cause.effectIds.length,
    beforeInputs
  );
  if (
    currentResults.length !== cause.effectIds.length
    || currentResults.some((message, index) => (
      message.kind !== 'effect_result'
      || message.effectId !== cause.effectIds[index]
      || message.toolCallId !== cause.toolCallIds[index]
    ))
  ) throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
}

type ExpectedEffectResult =
  | {
      readonly effect: AgentEffect;
      readonly status: 'succeeded' | 'failed';
    }
  | {
      readonly effect: AgentEffect;
      readonly status: 'cancelled';
      readonly cancellationReason: string;
    };

function expectedEffectResultsForTurn(
  run: AgentRun,
  turnId: string
): readonly ExpectedEffectResult[] {
  const targetIndex = run.turns.findIndex((turn) => turn.turnId === turnId);
  if (targetIndex < 0) {
    throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
  }
  const expected: ExpectedEffectResult[] = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const turn = run.turns[index];
    if (turn === undefined) {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    const cause = turn.intention.cause;
    if (cause.kind !== 'effect_results') continue;
    const source = run.turns.find((candidate) => candidate.turnId === cause.sourceTurnId);
    const attempt = source?.attempts.find(
      (candidate) => candidate.attemptId === cause.sourceAttemptId
    );
    if (
      attempt?.state.status !== 'succeeded'
      || attempt.state.directive.kind !== 'invoke_tools'
      || attempt.state.directiveDigest !== cause.sourceDirectiveDigest
      || attempt.state.directive.invocations.length !== cause.effectIds.length
    ) {
      throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
    }
    for (const [invocationIndex, invocation] of attempt.state.directive.invocations.entries()) {
      const effectId = cause.effectIds[invocationIndex];
      const toolCallId = cause.toolCallIds[invocationIndex];
      const effect = run.effects.find((candidate) => candidate.effectId === effectId);
      if (
        effect === undefined
        || invocation.effectId !== effectId
        || invocation.toolCallId !== toolCallId
        || effect.toolCallId !== toolCallId
        || (
          effect.state.status !== 'succeeded'
          && effect.state.status !== 'failed'
          && effect.state.status !== 'cancelled'
        )
      ) {
        throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
      }
      if (effect.state.status === 'cancelled') {
        try {
          assertSanitizedAgentEffectCancellationReason(effect.state.reason);
        } catch {
          throw turnInputConflict(run.runId, 'turn_input_cause_mismatch');
        }
      }
      expected.push(effect.state.status === 'cancelled'
        ? {
            effect,
            status: 'cancelled',
            cancellationReason: effect.state.reason
          }
        : { effect, status: effect.state.status });
    }
  }
  return expected;
}

function structuredEffectResults(
  snapshot: AgentTurnInputSnapshotV1
): readonly Extract<AgentTurnInputMessage, { readonly kind: 'effect_result' }>[] {
  return snapshot.messages.filter(
    (message): message is Extract<AgentTurnInputMessage, { readonly kind: 'effect_result' }> =>
      message.kind === 'effect_result'
  );
}

function isExactCancelledResult(value: AgentJsonValue, reason: string): boolean {
  return isExactDataObject(value, ['kind', 'schemaVersion', 'reason'])
    && (value as Readonly<Record<string, AgentJsonValue>>).kind
      === AGENT_EFFECT_CANCELLATION_RESULT_FORMAT
    && (value as Readonly<Record<string, AgentJsonValue>>).schemaVersion === 1
    && (value as Readonly<Record<string, AgentJsonValue>>).reason === reason;
}

function canonicalizeJsonData(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJsonData).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeJsonData(record[key])}`
  ).join(',')}}`;
}

function authorityMatchesBinding(
  authority: AgentTurnInputAuthorityReference,
  run: AgentRun
): boolean {
  const objective = run.binding.objectiveRef;
  if (authority.kind === 'conversation_message') {
    return isExactDataObject(authority, [
      'kind', 'sessionId', 'workspaceId', 'messageId', 'messageVersion', 'contentDigest'
    ])
      && objective.kind === 'conversation_message'
      && authority.sessionId === run.binding.sessionId
      && authority.workspaceId === run.binding.workspace.workspaceId
      && authority.messageId === objective.messageId
      && authority.messageVersion === objective.messageVersion
      && authority.contentDigest === objective.contentDigest;
  }
  return authority.kind === 'parent_delegation'
    && isExactDataObject(authority, [
    'kind', 'parentRunId', 'delegationId', 'objectiveDigest'
  ])
    && objective.kind === 'parent_delegation'
    && authority.parentRunId === objective.parentRunId
    && authority.delegationId === objective.delegationId
    && authority.objectiveDigest === objective.objectiveDigest;
}

function sameTurnCause(left: AgentTurnCause, right: AgentTurnCause): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'conversation_objective':
      return right.kind === left.kind
        && left.messageId === right.messageId
        && left.messageVersion === right.messageVersion
        && left.contentDigest === right.contentDigest;
    case 'delegation_objective':
      return right.kind === left.kind
        && left.parentRunId === right.parentRunId
        && left.delegationId === right.delegationId
        && left.objectiveDigest === right.objectiveDigest;
    case 'effect_results':
      return right.kind === left.kind
        && left.sourceTurnId === right.sourceTurnId
        && left.sourceAttemptId === right.sourceAttemptId
        && left.sourceDirectiveDigest === right.sourceDirectiveDigest
        && sameStringArray(left.effectIds, right.effectIds)
        && sameStringArray(left.toolCallIds, right.toolCallIds)
        && sameStringArray(left.inboxInputIds ?? [], right.inboxInputIds ?? []);
    case 'inbox_inputs':
      return right.kind === left.kind
        && left.sourceTurnId === right.sourceTurnId
        && left.sourceAttemptId === right.sourceAttemptId
        && left.sourceDirectiveDigest === right.sourceDirectiveDigest
        && sameStringArray(left.inputIds, right.inputIds);
    case 'child_results':
      return right.kind === left.kind
        && left.sourceTurnId === right.sourceTurnId
        && left.sourceAttemptId === right.sourceAttemptId
        && left.sourceDirectiveDigest === right.sourceDirectiveDigest
        && sameStringArray(left.delegationIds, right.delegationIds)
        && sameStringArray(left.childRunIds, right.childRunIds);
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExactDataObject(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
    });
}

function turnInputConflict(
  runId: string,
  reason:
    | 'missing_turn_input'
    | 'unexpected_turn_input'
    | 'turn_input_digest_mismatch'
    | 'turn_input_cause_mismatch'
    | 'turn_input_catalog_mismatch'
): AgentRunRecoveryConflictError {
  return new AgentRunRecoveryConflictError(
    runId,
    'immutable_payload_conflict',
    `Protected Turn input invariant failed: ${reason}.`
  );
}

interface DirectiveArtifactIdentity {
  readonly kind: AgentDirectivePayloadCommit['kind'];
  readonly directiveDigest: string;
  readonly contentDigest: string;
}

function collectDirectiveArtifactReferences(
  run: AgentRun | null
): ReadonlyMap<string, DirectiveArtifactIdentity> {
  const references = new Map<string, DirectiveArtifactIdentity>();
  for (const turn of run?.turns ?? []) {
    for (const attempt of turn.attempts) {
      if (attempt.state.status !== 'succeeded') continue;
      const directive = attempt.state.directive;
      let reference: (DirectiveArtifactIdentity & { artifactId: string }) | null = null;
      switch (directive.kind) {
        case 'respond':
          reference = {
            artifactId: directive.contentRef,
            kind: 'response_content',
            directiveDigest: attempt.state.directiveDigest,
            contentDigest: directive.contentDigest
          };
          break;
        case 'checkpoint':
          reference = {
            artifactId: directive.reasonRef,
            kind: 'checkpoint_reason',
            directiveDigest: attempt.state.directiveDigest,
            contentDigest: directive.reasonDigest
          };
          break;
        case 'complete':
          if (directive.outputRef !== undefined && directive.outputDigest !== undefined) {
            reference = {
              artifactId: directive.outputRef,
              kind: 'completion_output',
              directiveDigest: attempt.state.directiveDigest,
              contentDigest: directive.outputDigest
            };
          }
          break;
        case 'delegate_subagent':
          break;
        case 'fail':
          reference = {
            artifactId: directive.messageRef,
            kind: 'failure_message',
            directiveDigest: attempt.state.directiveDigest,
            contentDigest: directive.messageDigest
          };
          break;
        case 'invoke_tools':
        case 'request_decision':
          break;
      }
      if (reference !== null) {
        if (references.has(reference.artifactId)) {
          throw new AgentRunInvariantError('Directive artifact IDs must be unique per Run.');
        }
        references.set(reference.artifactId, reference);
      }
    }
  }
  return references;
}

function assertExactCheckpoint(
  run: AgentRun,
  checkpoint: AgentRunCheckpointCommit
): void {
  if (
    !Number.isSafeInteger(checkpoint.checkpointVersion)
    || checkpoint.checkpointVersion <= 0
    || checkpoint.checkpointVersion !== run.state.checkpointVersion
    || !isTimestamp(checkpoint.createdAt)
    || checkpoint.payload.format !== 'ariadne.agent-checkpoint'
    || checkpoint.payload.schemaVersion !== 1
  ) {
    throw checkpointConflict(
      run.runId,
      'A committed checkpoint must exactly match the resulting AgentRun checkpoint.'
    );
  }
  assertJsonValue(checkpoint.payload, 'checkpoint.payload');
}

function checkpointConflict(runId: string, message: string): AgentRunRecoveryConflictError {
  return new AgentRunRecoveryConflictError(runId, 'checkpoint_mismatch', message);
}

function assertJsonValue(value: unknown, path: string): asserts value is AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new AgentRunInvariantError(`${path} must contain finite JSON numbers.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new AgentRunInvariantError(`${path} must be JSON serializable.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      throw new AgentRunInvariantError(`${path}.${key} must not be undefined.`);
    }
    assertJsonValue(item, `${path}.${key}`);
  }
}

function isTimestamp(value: string): boolean {
  return isCanonicalIsoTimestamp(value);
}
