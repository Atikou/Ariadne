import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  assertValidAgentRun,
  assertValidDecision,
  getActiveDecision,
  sha256AgentControlData,
  type AgentDecision,
  type AgentDecisionResolution,
  type AgentRun,
  type AgentRunCommandReceipt,
  type AgentRunEvent,
  type AgentRunEventPayload,
  type AgentRunOutboxStore,
  type ClaimedAgentRunOutboxMessage
} from '@ariadne/agent-core';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  derivePublicDecisionActionDescriptorV1,
  publicDecisionProjectionV3Schema,
  publicDecisionChoicesV1,
  publicPlanDecisionPresentationSourceV1Schema,
  publicRunProjectionV3Schema,
  redactPublicProjectionTextV3,
  type ProjectionCommitV3,
  type PublicDecisionPresentationV1,
  type PublicDecisionProjectionV3,
  type PublicRunProjectionV3
} from '@ariadne/protocol/public';
import type {
  AgentRunInteractionProjectionMessage,
  AgentRunInteractionProjectionResolver,
  AgentRunTerminalResultProjectionSink,
  AgentRunVersionReader
} from './AgentRunProjectionPorts.js';
import type { PublicProjectionCommitSink } from './PublicProjectionPorts.js';
import { assertValidProjectionCommitV3 } from './PublicProjectionContractV3.js';

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 1_000;

export interface AgentRunPublicProjectionPublisherOptions {
  readonly claimLeaseMs?: number;
  readonly claimLimit?: number;
  readonly claimIdFactory?: () => string;
  readonly terminalResultSink?: AgentRunTerminalResultProjectionSink;
  readonly interactionResolver?: AgentRunInteractionProjectionResolver;
}

export interface AgentRunPublicProjectionPublishResult {
  readonly claimedMessages: number;
  readonly projectedVersions: number;
  readonly acknowledgedMessages: number;
}

interface ClaimedRunVersion {
  readonly runId: string;
  readonly version: number;
  readonly commandId: string;
  readonly messages: readonly ClaimedAgentRunOutboxMessage[];
}

interface ImmutableRunVersion {
  readonly run: AgentRun;
  readonly events: readonly AgentRunEvent[];
}

type RequestedDecisionEvent = EventWithPayload<
  Extract<AgentRunEventPayload, { readonly type: 'decision.requested' }>
>;
type ResolvedDecisionEvent = EventWithPayload<
  Extract<AgentRunEventPayload, { readonly type: 'decision.resolved' }>
>;
type StateChangedEvent = EventWithPayload<
  Extract<AgentRunEventPayload, { readonly type: 'run.state_changed' }>
>;
type EventWithPayload<TPayload extends AgentRunEventPayload> = Omit<
  AgentRunEvent,
  'payload'
> & { readonly payload: TPayload };

/**
 * Publishes one deterministic public commit for every immutable AgentRun
 * version. The complete command receipt, rather than the current outbox page,
 * is the projection source: a page split therefore cannot change the payload
 * associated with the stable public event identity.
 *
 * Terminal Conversation projection remains the first side effect. Public
 * append follows it, and only a successful append permits outbox ACK.
 */
export class AgentRunPublicProjectionPublisher {
  private readonly claimLeaseMs: number;
  private readonly claimLimit: number;
  private readonly claimIdFactory: () => string;
  private readonly terminalResultSink?: AgentRunTerminalResultProjectionSink;
  private readonly interactionResolver?: AgentRunInteractionProjectionResolver;
  private activePublish: Promise<AgentRunPublicProjectionPublishResult> | null = null;

  public constructor(
    private readonly outbox: AgentRunOutboxStore,
    private readonly runVersions: AgentRunVersionReader,
    private readonly sink: PublicProjectionCommitSink,
    options: AgentRunPublicProjectionPublisherOptions = {}
  ) {
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.claimLimit = options.claimLimit ?? DEFAULT_CLAIM_LIMIT;
    this.claimIdFactory = options.claimIdFactory
      ?? (() => `agent-run-public-projection:${randomUUID()}`);
    this.terminalResultSink = options.terminalResultSink;
    this.interactionResolver = options.interactionResolver;
    assertOptions(this.claimLeaseMs, this.claimLimit);
  }

  /** Concurrent calls share one claim/append/ack operation. */
  public publishPending(): Promise<AgentRunPublicProjectionPublishResult> {
    if (this.activePublish === null) {
      this.activePublish = this.publishClaimedBatch().finally(() => {
        this.activePublish = null;
      });
    }
    return this.activePublish;
  }

  private async publishClaimedBatch(): Promise<AgentRunPublicProjectionPublishResult> {
    const claimId = this.claimIdFactory();
    if (typeof claimId !== 'string' || claimId.trim().length === 0) {
      throw new Error('agent_run_projection_claim_id_invalid');
    }
    const messages = await this.outbox.claimPending({
      claimId,
      leaseMs: this.claimLeaseMs,
      limit: this.claimLimit
    });
    const groups = groupClaimedRunVersions(messages, claimId);
    const receipts = new Map<string, Promise<AgentRunCommandReceipt | null>>();
    let acknowledgedMessages = 0;

    for (const group of groups) {
      const immutable = await loadImmutableRunVersion(
        group,
        this.runVersions,
        receipts
      );
      const decision = await projectDecisionForVersion(
        immutable.run,
        immutable.events,
        this.runVersions
      );
      const interactions = await resolveInteractionMessages(
        immutable.run,
        this.interactionResolver
      );
      const commit = publicCommit(immutable.run, decision, interactions);

      if (isTerminalRun(immutable.run) && this.terminalResultSink !== undefined) {
        const terminalEvent = terminalEventForRun(immutable.events, immutable.run);
        await this.terminalResultSink.projectTerminalResult({
          run: immutable.run,
          sourceRunEventId: terminalEvent.eventId,
          occurredAt: terminalEvent.occurredAt
        });
      }

      await this.sink.append(commit);
      const acknowledgements = group.messages.map((message) => ({
        cursor: message.cursor,
        eventId: message.eventId
      }));
      await this.outbox.markPublished({ claimId, messages: acknowledgements });
      acknowledgedMessages += acknowledgements.length;
    }

    return {
      claimedMessages: messages.length,
      projectedVersions: groups.length,
      acknowledgedMessages
    };
  }
}

function publicCommit(
  run: AgentRun,
  decision: PublicDecisionProjectionV3 | null,
  interactions: readonly AgentRunInteractionProjectionMessage[]
): ProjectionCommitV3 {
  const changes: ProjectionCommitV3['changes'] = [
    {
      feature: 'runs',
      operation: 'upsert',
      aggregateId: run.runId,
      aggregateVersion: run.version,
      projectedAt: run.updatedAt,
      dto: projectAgentRunV3(run, interactions)
    },
    ...(decision === null
      ? []
      : [{
          feature: 'decisions' as const,
          operation: 'upsert' as const,
          aggregateId: decision.decisionId,
          aggregateVersion: decision.version,
          projectedAt: run.updatedAt,
          dto: decision
        }])
  ];

  return assertValidProjectionCommitV3({
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: agentRunChangedPublicEventId(run.runId, run.version),
    sourceId: agentRunProjectionSourceId(run.runId),
    sourceCursor: run.version,
    occurredAt: run.updatedAt,
    changes
  });
}

/** Fixed-length identity that remains valid for maximum-length public Run IDs. */
export function agentRunChangedPublicEventId(
  runId: string,
  version: number
): string {
  if (
    runId.length === 0
    || runId.length > 256
    || runId.trim() !== runId
    || !Number.isSafeInteger(version)
    || version <= 0
  ) {
    throw new Error('agent_run_projection_public_identity_invalid');
  }
  return stablePublicIdentity('agent-run.changed', [
    'ariadne.agent-run.changed',
    runId,
    version
  ]);
}

export function agentRunProjectionSourceId(runId: string): string {
  if (
    runId.length === 0
    || runId.length > 256
    || runId.trim() !== runId
  ) {
    throw new Error('agent_run_projection_public_identity_invalid');
  }
  return stablePublicIdentity('agent-run', [
    'ariadne.agent-run.source',
    runId
  ]);
}

export function projectAgentRunV3(
  run: AgentRun,
  interactions: readonly AgentRunInteractionProjectionMessage[] = []
): PublicRunProjectionV3 {
  assertValidAgentRun(run);
  return publicRunProjectionV3Schema.parse({
    runId: run.runId,
    sessionId: run.binding.sessionId,
    ...(run.binding.objectiveRef.kind === 'conversation_message'
      ? { sourceMessageId: run.binding.objectiveRef.messageId }
      : {}),
    version: run.version,
    title: 'Agent run',
    status: publicRunStatus(run),
    label: publicRunLabel(run),
    toolActivities: run.effects.map((effect) => {
      const state = effect.state;
      const occurredAt = effectTimestamp(state);
      return {
        activityId: effect.effectId,
        callId: stablePublicIdentity('tool-call', [
          'ariadne.agent-run.tool-call',
          run.runId,
          effect.effectId
        ]),
        toolName: effect.tool.toolName,
        status: state.status === 'succeeded'
          ? 'completed' as const
          : state.status === 'failed' || state.status === 'uncertain' || state.status === 'cancelled'
            ? 'failed' as const
            : state.status === 'started'
              ? 'running' as const
              : 'pending' as const,
        occurredAt,
        ...(state.status === 'started' ? { startedAt: state.startedAt } : {}),
        ...(state.status === 'succeeded' || state.status === 'failed'
          ? { completedAt: state.finishedAt }
          : state.status === 'cancelled'
            ? { completedAt: state.cancelledAt }
            : {})
      };
    }),
    inbox: run.inbox.map((input) => ({
      inputId: input.inputId,
      messageId: input.messageId,
      version: input.version,
      delivery: input.delivery,
      content: redactPublicProjectionTextV3(input.content),
      state: input.state,
      queuedAt: input.queuedAt,
      updatedAt: input.updatedAt,
      ...(input.state === 'claimed' ? { claimedTurnId: input.claimedTurnId } : {})
    })),
    interactionMessages: interactions.map((message) => ({
      messageId: message.messageId,
      sessionId: run.binding.sessionId,
      runId: run.runId,
      version: 1,
      role: message.role,
      content: redactPublicProjectionTextV3(message.content),
      status: 'completed' as const,
      createdAt: message.occurredAt,
      updatedAt: message.occurredAt
    })),
    updatedAt: run.updatedAt,
    ...(run.state.status === 'queued' ? {} : { startedAt: run.createdAt }),
    ...terminalTimestamp(run)
  });
}

async function resolveInteractionMessages(
  run: AgentRun,
  resolver: AgentRunInteractionProjectionResolver | undefined
): Promise<readonly AgentRunInteractionProjectionMessage[]> {
  const requiresResolver = run.turns.slice(1).some((turn) => {
    const cause = turn.intention.cause;
    return cause.kind === 'inbox_inputs'
      || (cause.kind === 'effect_results' && (cause.inboxInputIds?.length ?? 0) > 0);
  });
  if (!requiresResolver) return [];
  if (resolver === undefined) {
    throw new Error('agent_run_interaction_projection_resolver_unavailable');
  }
  return resolver.resolveInteractionMessages(run);
}

function effectTimestamp(effect: AgentRun['effects'][number]['state']): string {
  switch (effect.status) {
    case 'intended': return effect.intendedAt;
    case 'authorized': return effect.authorizedAt;
    case 'started': return effect.startedAt;
    case 'succeeded':
    case 'failed': return effect.finishedAt;
    case 'uncertain': return effect.observedAt;
    case 'cancelled': return effect.cancelledAt;
  }
}

async function projectRequestedDecision(
  decision: AgentDecision,
  run: AgentRun,
  runVersions: AgentRunVersionReader
): Promise<PublicDecisionProjectionV3> {
  const presentation = await publicDecisionPresentation(decision, run, runVersions);
  const action = await derivePublicDecisionActionDescriptorV1(
    decision,
    run.binding.sessionId
  );
  return publicDecisionProjectionV3Schema.parse({
    decisionId: decision.decisionId,
    runId: run.runId,
    sessionId: run.binding.sessionId,
    version: 1,
    kind: decision.kind,
    status: 'pending',
    presentation,
    requestedAt: decision.requestedAt,
    action
  });
}

async function projectResolvedDecision(
  decision: AgentDecision,
  resolution: AgentDecisionResolution,
  run: AgentRun,
  runVersions: AgentRunVersionReader
): Promise<PublicDecisionProjectionV3> {
  const status = publicResolutionStatus(resolution);
  const presentation = await publicDecisionPresentation(decision, run, runVersions);
  return publicDecisionProjectionV3Schema.parse({
    decisionId: decision.decisionId,
    runId: run.runId,
    sessionId: run.binding.sessionId,
    version: 2,
    kind: decision.kind,
    status,
    presentation,
    requestedAt: decision.requestedAt,
    resolvedAt: resolution.resolvedAt
  });
}

async function projectExpiredDecision(
  decision: AgentDecision,
  run: AgentRun,
  runVersions: AgentRunVersionReader
): Promise<PublicDecisionProjectionV3> {
  const presentation = await publicDecisionPresentation(decision, run, runVersions);
  return publicDecisionProjectionV3Schema.parse({
    decisionId: decision.decisionId,
    runId: run.runId,
    sessionId: run.binding.sessionId,
    version: 2,
    kind: decision.kind,
    status: 'expired',
    presentation,
    requestedAt: decision.requestedAt,
    resolvedAt: run.updatedAt
  });
}

async function projectDecisionForVersion(
  run: AgentRun,
  events: readonly AgentRunEvent[],
  runVersions: AgentRunVersionReader
): Promise<PublicDecisionProjectionV3 | null> {
  const requested = events.filter(isRequestedDecisionEvent);
  const resolved = events.filter(isResolvedDecisionEvent);
  if (requested.length + resolved.length > 1) {
    throw new Error(
      `agent_run_projection_decision_event_ambiguous:${run.runId}:${String(run.version)}`
    );
  }

  const active = getActiveDecision(run);
  if (requested[0] !== undefined) {
    const decision = requested[0].payload.decision;
    assertValidDecision(decision);
    if (
      active === null
      || !isDeepStrictEqual(active, decision)
      || decision.requestedAt !== requested[0].occurredAt
    ) {
      throw new Error(
        `agent_run_projection_decision_request_drift:${run.runId}:${String(run.version)}`
      );
    }
    return projectRequestedDecision(decision, run, runVersions);
  }

  if (resolved[0] !== undefined) {
    if (active !== null || run.version <= 1) {
      throw new Error(
        `agent_run_projection_decision_resolution_state_invalid:${run.runId}:${String(run.version)}`
      );
    }
    const previous = await loadPreviousRun(run, runVersions);
    const decision = getActiveDecision(previous);
    if (decision === null) {
      throw new Error(
        `agent_run_projection_decision_history_missing:${run.runId}:${String(run.version)}`
      );
    }
    assertResolutionMatchesDecision(
      decision,
      resolved[0].payload.decisionId,
      resolved[0].payload.resolution,
      resolved[0].occurredAt
    );
    return projectResolvedDecision(
      decision,
      resolved[0].payload.resolution,
      run,
      runVersions
    );
  }

  if (active !== null) {
    throw new Error(
      `agent_run_projection_decision_event_missing:${run.runId}:${String(run.version)}`
    );
  }

  if (isTerminalRun(run) && run.version > 1) {
    const previous = await loadPreviousRun(run, runVersions);
    const expired = getActiveDecision(previous);
    if (expired !== null) return projectExpiredDecision(expired, run, runVersions);
  }
  return null;
}

async function loadPreviousRun(
  run: AgentRun,
  runVersions: AgentRunVersionReader
): Promise<AgentRun> {
  const previous = await runVersions.loadRunVersion(run.runId, run.version - 1);
  if (previous === null) {
    throw new Error(
      `agent_run_projection_previous_version_missing:${run.runId}:${String(run.version - 1)}`
    );
  }
  assertValidAgentRun(previous);
  if (
    previous.runId !== run.runId
    || previous.version !== run.version - 1
    || previous.binding.sessionId !== run.binding.sessionId
  ) {
    throw new Error(
      `agent_run_projection_previous_version_drift:${run.runId}:${String(run.version)}`
    );
  }
  return previous;
}

async function loadImmutableRunVersion(
  group: ClaimedRunVersion,
  runVersions: AgentRunVersionReader,
  receiptCache: Map<string, Promise<AgentRunCommandReceipt | null>>
): Promise<ImmutableRunVersion> {
  const runPromise = runVersions.loadRunVersion(group.runId, group.version);
  let receiptPromise = receiptCache.get(group.commandId);
  if (receiptPromise === undefined) {
    receiptPromise = runVersions.loadCommittedCommandReceipt(group.commandId);
    receiptCache.set(group.commandId, receiptPromise);
  }
  const [run, receipt] = await Promise.all([runPromise, receiptPromise]);
  if (run === null) {
    throw new Error(
      `agent_run_projection_version_missing:${group.runId}:${String(group.version)}`
    );
  }
  if (receipt === null || receipt.commandId !== group.commandId) {
    throw new Error(
      `agent_run_projection_receipt_missing:${group.commandId}`
    );
  }
  assertValidAgentRun(run);
  if (run.runId !== group.runId || run.version !== group.version) {
    throw new Error(
      `agent_run_projection_version_mismatch:${group.runId}:${String(group.version)}`
    );
  }

  const mutations = receipt.mutations.filter((mutation) => (
    mutation.runId === group.runId
    && mutation.resultingVersion === group.version
  ));
  const mutation = mutations[0];
  if (mutations.length !== 1 || mutation === undefined) {
    throw new Error(
      `agent_run_projection_receipt_version_invalid:${group.runId}:${String(group.version)}`
    );
  }
  if (!isDeepStrictEqual(mutation.run, run)) {
    throw new Error(
      `agent_run_projection_historical_run_drift:${group.runId}:${String(group.version)}`
    );
  }
  assertCompleteVersionEvents(mutation.events, group, run);
  return { run, events: mutation.events };
}

function assertCompleteVersionEvents(
  events: readonly AgentRunEvent[],
  group: ClaimedRunVersion,
  run: AgentRun
): void {
  if (events.length === 0) {
    throw new Error(
      `agent_run_projection_event_set_empty:${run.runId}:${String(run.version)}`
    );
  }
  const eventsById = new Map<string, AgentRunEvent>();
  for (const [index, event] of events.entries()) {
    if (
      event.commandId !== group.commandId
      || event.runId !== run.runId
      || event.runVersion !== run.version
      || event.sequence !== index + 1
      || event.occurredAt !== run.updatedAt
      || event.eventId.trim().length === 0
      || eventsById.has(event.eventId)
    ) {
      throw new Error(
        `agent_run_projection_event_set_drift:${run.runId}:${String(run.version)}`
      );
    }
    eventsById.set(event.eventId, event);
  }

  const stateEvents = events.filter(isStateChangedEvent);
  const stateEvent = stateEvents[0];
  if (
    stateEvents.length !== 1
    || stateEvent === undefined
    || !isDeepStrictEqual(stateEvent.payload.to, run.state)
    || (run.version === 1 && stateEvent.payload.from !== 'absent')
    || (run.version > 1 && stateEvent.payload.from === 'absent')
  ) {
    throw new Error(
      `agent_run_projection_state_event_drift:${run.runId}:${String(run.version)}`
    );
  }

  for (const message of group.messages) {
    const persisted = eventsById.get(message.eventId);
    if (persisted === undefined || !isDeepStrictEqual(persisted, message.event)) {
      throw new Error(
        `agent_run_projection_outbox_payload_drift:${run.runId}:${String(run.version)}`
      );
    }
  }
}

function assertResolutionMatchesDecision(
  decision: AgentDecision,
  eventDecisionId: string,
  resolution: AgentDecisionResolution,
  occurredAt: string
): void {
  assertValidDecision(decision);
  if (
    eventDecisionId !== decision.decisionId
    || resolution.decisionId !== decision.decisionId
    || resolution.kind !== decision.kind
    || !isDeepStrictEqual(resolution.checkpoint, decision.checkpoint)
    || resolution.resolvedAt !== occurredAt
  ) {
    throw new Error('agent_run_projection_decision_resolution_drift');
  }

  if (decision.kind === 'permission' && resolution.kind === 'permission') {
    const validOutcome = resolution.outcome === 'allow_once'
      || resolution.outcome === 'allow_run'
      || resolution.outcome === 'deny';
    const validCapabilities = resolution.outcome === 'deny'
      ? resolution.approvedCapabilityIds.length === 0
      : isDeepStrictEqual(resolution.approvedCapabilityIds, decision.capabilityIds);
    if (!validOutcome || !validCapabilities || resolution.effectId !== decision.effectId) {
      throw new Error('agent_run_projection_decision_resolution_drift');
    }
    return;
  }

  if (decision.kind === 'plan' && resolution.kind === 'plan') {
    if (
      (resolution.outcome !== 'approve' && resolution.outcome !== 'reject')
      || resolution.planId !== decision.planId
      || resolution.planVersion !== decision.planVersion
      || resolution.planHash !== decision.planHash
    ) {
      throw new Error('agent_run_projection_decision_resolution_drift');
    }
    return;
  }

  if (decision.kind === 'recovery' && resolution.kind === 'recovery') {
    if (
      resolution.effectId !== decision.effectId
      || !decision.allowedActions.includes(resolution.outcome)
      || !publicDecisionChoicesV1(decision).includes(resolution.outcome)
    ) {
      throw new Error('agent_run_projection_decision_resolution_drift');
    }
    return;
  }

  throw new Error('agent_run_projection_decision_resolution_drift');
}

function publicResolutionStatus(
  resolution: AgentDecisionResolution
): 'approved' | 'rejected' {
  if (resolution.kind === 'permission') {
    return resolution.outcome === 'deny' ? 'rejected' : 'approved';
  }
  if (resolution.kind === 'plan') {
    return resolution.outcome === 'reject' ? 'rejected' : 'approved';
  }
  return 'approved';
}

async function publicDecisionPresentation(
  decision: AgentDecision,
  run: AgentRun,
  runVersions: AgentRunVersionReader
): Promise<PublicDecisionPresentationV1> {
  if (decision.kind === 'permission') {
    const effect = run.effects.find((candidate) => (
      candidate.effectId === decision.effectId
      && candidate.toolCallId === decision.toolCallId
    ));
    if (effect === undefined) {
      throw new Error('agent_run_projection_permission_effect_missing');
    }
    return {
      contractVersion: '1.0',
      kind: 'permission',
      headline: 'Permission required',
      summary: `Tool ${effect.tool.toolName} requests the listed capabilities before it can run.`,
      toolName: effect.tool.toolName,
      capabilityIds: [...decision.capabilityIds],
      scopeIds: [...decision.scope],
      resourceSummary: decision.scope.length === 0
        ? 'No narrower resource identifier was requested beyond the Run grant.'
        : 'The permission applies only to the listed resource scope identifiers.'
    };
  }

  if (decision.kind === 'plan') {
    const reference = {
      planId: decision.planId,
      version: decision.planVersion,
      contentHash: decision.planHash
    };
    if (runVersions.loadPlanVersion === undefined) {
      throw new Error('agent_run_projection_plan_version_reader_unavailable');
    }
    const plan = await runVersions.loadPlanVersion(reference);
    if (
      plan === null
      || plan.runId !== decision.runId
      || plan.ref.planId !== reference.planId
      || plan.ref.version !== reference.version
      || plan.ref.contentHash !== reference.contentHash
      || await sha256AgentControlData(plan.payload) !== reference.contentHash
    ) {
      throw new Error('agent_run_projection_plan_version_drift');
    }
    const source = extractPlanPublicPresentation(plan.payload);
    return {
      contractVersion: '1.0',
      kind: 'plan',
      headline: 'Plan approval required',
      summary: source.summary,
      impactSummary: source.impactSummary,
      approvalScope: 'continue_run_with_presented_plan',
      steps: source.steps.map((step) => ({ ...step }))
    };
  }

  return {
    contractVersion: '1.0',
    kind: 'recovery',
    headline: 'Recovery decision required',
    summary: 'Choose how to recover this run. Private recovery evidence is not exposed.'
  };
}

function extractPlanPublicPresentation(
  payload: unknown
): ReturnType<typeof publicPlanDecisionPresentationSourceV1Schema.parse> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('agent_run_projection_plan_presentation_missing');
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('agent_run_projection_plan_presentation_invalid');
  }
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'publicPresentation');
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !('value' in descriptor)
  ) {
    throw new Error('agent_run_projection_plan_presentation_missing');
  }
  return publicPlanDecisionPresentationSourceV1Schema.parse(descriptor.value);
}

function publicRunStatus(
  run: AgentRun
): PublicRunProjectionV3['status'] {
  switch (run.state.status) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'waiting':
      return run.state.reason === 'tool_permission'
        ? 'waiting_permission'
        : 'waiting_decision';
    case 'recovering': return 'interrupted';
    case 'waiting_children': return 'waiting_children';
    case 'cancelling': return 'cancelling';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

function publicRunLabel(run: AgentRun): string {
  switch (run.state.status) {
    case 'queued': return 'Waiting to run';
    case 'running': return 'Running';
    case 'waiting':
      return run.state.reason === 'tool_permission'
        ? 'Waiting for permission'
        : 'Waiting for decision';
    case 'recovering': return 'Recovery required';
    case 'waiting_children': return 'Waiting for child runs';
    case 'cancelling': return 'Cancelling child runs';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

function terminalTimestamp(
  run: AgentRun
): Pick<PublicRunProjectionV3, 'completedAt'> {
  switch (run.state.status) {
    case 'completed': return { completedAt: run.state.completedAt };
    case 'failed': return { completedAt: run.state.failedAt };
    case 'cancelled': return { completedAt: run.state.cancelledAt };
    default: return {};
  }
}

function groupClaimedRunVersions(
  messages: readonly ClaimedAgentRunOutboxMessage[],
  expectedClaimId: string
): readonly ClaimedRunVersion[] {
  const grouped = new Map<string, {
    runId: string;
    version: number;
    commandId: string;
    messages: ClaimedAgentRunOutboxMessage[];
  }>();
  const cursors = new Set<number>();
  const eventIds = new Set<string>();

  for (const message of messages) {
    if (
      message.claimId !== expectedClaimId
      || !Number.isSafeInteger(message.cursor)
      || message.cursor <= 0
      || message.eventId.trim().length === 0
      || message.event.eventId !== message.eventId
      || message.event.commandId.trim().length === 0
      || message.event.runId.trim().length === 0
      || !Number.isSafeInteger(message.event.runVersion)
      || message.event.runVersion <= 0
      || !Number.isSafeInteger(message.event.sequence)
      || message.event.sequence <= 0
      || cursors.has(message.cursor)
      || eventIds.has(message.eventId)
    ) {
      throw new Error('agent_run_projection_claim_invalid');
    }
    cursors.add(message.cursor);
    eventIds.add(message.eventId);
    const key = JSON.stringify([message.event.runId, message.event.runVersion]);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        runId: message.event.runId,
        version: message.event.runVersion,
        commandId: message.event.commandId,
        messages: [message]
      });
    } else {
      if (current.commandId !== message.event.commandId) {
        throw new Error('agent_run_projection_claim_command_drift');
      }
      current.messages.push(message);
    }
  }

  return [...grouped.values()]
    .sort((left, right) => left.messages[0]!.cursor - right.messages[0]!.cursor);
}

function terminalEventForRun(
  events: readonly AgentRunEvent[],
  run: AgentRun
): AgentRunEvent {
  const expectedType = run.state.status === 'completed'
    ? 'run.completed'
    : run.state.status === 'failed'
      ? 'run.failed'
      : run.state.status === 'cancelled'
        ? 'run.cancelled'
        : null;
  if (expectedType === null) {
    throw new Error('agent_run_projection_terminal_event_requested_for_active_run');
  }
  const matches = events.filter((event) => event.payload.type === expectedType);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(
      `agent_run_projection_terminal_event_invalid:${run.runId}:${String(run.version)}`
    );
  }
  return matches[0];
}

function isRequestedDecisionEvent(event: AgentRunEvent): event is RequestedDecisionEvent {
  return event.payload.type === 'decision.requested';
}

function isResolvedDecisionEvent(event: AgentRunEvent): event is ResolvedDecisionEvent {
  return event.payload.type === 'decision.resolved';
}

function isStateChangedEvent(event: AgentRunEvent): event is StateChangedEvent {
  return event.payload.type === 'run.state_changed';
}

function isTerminalRun(run: AgentRun): boolean {
  return run.state.status === 'completed'
    || run.state.status === 'failed'
    || run.state.status === 'cancelled';
}

function stablePublicIdentity(prefix: string, identity: readonly unknown[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(identity), 'utf8')
    .digest('hex');
  return `${prefix}:${digest}`;
}

function assertOptions(claimLeaseMs: number, claimLimit: number): void {
  if (
    !Number.isSafeInteger(claimLeaseMs)
    || claimLeaseMs <= 0
    || claimLeaseMs > 5 * 60 * 1_000
    || !Number.isSafeInteger(claimLimit)
    || claimLimit <= 0
    || claimLimit > 1_000
  ) {
    throw new Error('agent_run_projection_options_invalid');
  }
}
