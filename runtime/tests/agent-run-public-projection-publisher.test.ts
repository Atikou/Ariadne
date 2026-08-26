import {
  type AgentDecision,
  type AgentDecisionResolution,
  type AgentEffect,
  type AgentPlanReference,
  type AgentPlanVersionCommit,
  type AgentRun,
  type AgentRunCommandReceipt,
  type AgentRunEvent,
  type AgentRunEventPayload,
  type AgentRunOutboxClaimRequest,
  type AgentRunOutboxPublishRequest,
  type AgentRunOutboxStore,
  type ClaimedAgentRunOutboxMessage,
  sha256AgentControlData
} from '@ariadne/agent-core';
import {
  projectionCommitV3Schema,
  publicDecisionActionTokenV1,
  type ProjectionCommitV3,
  type PublicDecisionChoiceV3
} from '@ariadne/protocol/public';
import { describe, expect, it } from 'vitest';

import type { AgentRunVersionReader } from '../src/projection/AgentRunProjectionPorts.js';
import type { PublicProjectionCommitSink } from '../src/projection/PublicProjectionPorts.js';
import {
  AgentRunPublicProjectionPublisher,
  agentRunChangedPublicEventId,
  agentRunProjectionSourceId,
  projectAgentRunV3
} from '../src/projection/AgentRunPublicProjectionPublisher.js';

describe('AgentRunPublicProjectionPublisher', () => {
  it.each([
    ['permission', ['allow_once', 'allow_run', 'deny'], 'approved'],
    ['plan', ['approve', 'reject'], 'rejected'],
    ['recovery', ['retry', 'mark_failed'], 'approved']
  ] as const)(
    'atomically upserts the Run and %s Decision request and resolution',
    async (kind, expectedChoices, expectedStatus) => {
      const lifecycle = await decisionLifecycle(kind);
      const request = requestArtifacts(lifecycle);
      const resolution = resolutionArtifacts(lifecycle);
      const outbox = new FakeAgentRunOutboxStore(messagesFor([request, resolution]));
      const sink = new IdempotentPublicEventSink();
      const publisher = new AgentRunPublicProjectionPublisher(
        outbox,
        new MapRunVersionReader([request, resolution]),
        sink,
        { claimIdFactory: () => `claim-${kind}` }
      );

      await expect(publisher.publishPending()).resolves.toEqual({
        claimedMessages: 4,
        projectedVersions: 2,
        acknowledgedMessages: 4
      });
      expect(sink.appendCalls).toHaveLength(2);

      const requestCommit = sink.appendCalls[0]!;
      const resolvedCommit = sink.appendCalls[1]!;
      expect(requestCommit.changes.map((change) => change.feature))
        .toEqual(['runs', 'decisions']);
      expect(resolvedCommit.changes.map((change) => change.feature))
        .toEqual(['runs', 'decisions']);
      expect(requestCommit.changes[1]).toMatchObject({
        feature: 'decisions',
        aggregateId: lifecycle.decision.decisionId,
        aggregateVersion: 1,
        dto: {
          decisionId: lifecycle.decision.decisionId,
          runId: lifecycle.requestedRun.runId,
          sessionId: 'session-public',
          version: 1,
          kind,
          status: 'pending',
          presentation: { kind, contractVersion: '1.0' },
          action: {
            contractVersion: '1.0',
            choices: expectedChoices
          }
        }
      });
      expect(requestCommit.changes[1]!.dto).toMatchObject({
        action: { actionToken: expect.stringMatching(/^decision-action\.v1:[a-f0-9]{64}$/u) }
      });
      expect(resolvedCommit.changes[1]).toMatchObject({
        feature: 'decisions',
        aggregateId: lifecycle.decision.decisionId,
        aggregateVersion: 2,
        dto: {
          status: expectedStatus,
          requestedAt: lifecycle.decision.requestedAt,
          resolvedAt: lifecycle.resolution.resolvedAt
        }
      });
      expect(resolvedCommit.changes[1]!.dto).not.toHaveProperty('action');
      expect(outbox.publishCalls).toHaveLength(2);
      expect(() => projectionCommitV3Schema.parse(requestCommit)).not.toThrow();
      expect(() => projectionCommitV3Schema.parse(resolvedCommit)).not.toThrow();
    }
  );

  it('projects informed permission and plan semantics without private identities or payload data', async () => {
    const lifecycles = await Promise.all([
      decisionLifecycle('permission'),
      decisionLifecycle('plan'),
      decisionLifecycle('recovery')
    ]);
    const artifacts = lifecycles.flatMap((lifecycle) => [
      requestArtifacts(lifecycle),
      resolutionArtifacts(lifecycle)
    ]);
    const outbox = new FakeAgentRunOutboxStore(messagesFor(artifacts));
    const sink = new IdempotentPublicEventSink();
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader(artifacts),
      sink,
      { claimIdFactory: () => 'redaction-claim' }
    );

    await publisher.publishPending();
    const serialized = JSON.stringify(sink.appendCalls);
    expect(serialized).toContain('private-tool');
    expect(serialized).toContain('workspace.write');
    expect(serialized).toContain('workspace-private');
    expect(serialized).toContain('Apply the reviewed refactoring in bounded stages.');
    expect(serialized).toContain('Audit boundaries');
    for (const forbidden of [
      'permissionItems',
      'approvedCapabilityIds',
      'effectId',
      'toolCallId',
      'planId',
      'planHash',
      'uncertainty',
      'privateExecutionData',
      'internalNotes',
      'C:\\private\\recovery.txt',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'provider-secret',
      'model-secret',
      'policy-secret'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fails closed when a protected Plan has no strict public presentation', async () => {
    const lifecycle = await decisionLifecycle('plan');
    if (lifecycle.decision.kind !== 'plan') throw new Error('expected_plan_decision');
    const request = requestArtifacts(lifecycle);
    const privatePayload = { steps: ['private unreviewed execution step'] };
    const privateHash = await sha256AgentControlData(privatePayload);
    const decision = { ...lifecycle.decision, planHash: privateHash };
    const run = {
      ...request.run,
      state: {
        ...request.run.state,
        decision
      }
    } as AgentRun;
    const invalid = {
      ...request,
      run,
      events: request.events.map((event) => event.payload.type === 'decision.requested'
        ? { ...event, payload: { ...event.payload, decision } }
        : event.payload.type === 'run.state_changed'
          ? { ...event, payload: { ...event.payload, to: run.state } }
          : event),
      planVersion: {
        ref: {
          planId: decision.planId,
          version: decision.planVersion,
          contentHash: privateHash
        },
        runId: run.runId,
        payload: privatePayload,
        createdAt: decision.requestedAt
      }
    } satisfies VersionArtifacts;
    const outbox = new FakeAgentRunOutboxStore(messagesFor([invalid]));
    const sink = new IdempotentPublicEventSink();
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader([invalid]),
      sink,
      { claimIdFactory: () => 'missing-plan-presentation' }
    );

    await expect(publisher.publishPending()).rejects.toThrow(
      'agent_run_projection_plan_presentation_missing'
    );
    expect(sink.appendCalls).toEqual([]);
    expect(outbox.publishCalls).toEqual([]);
  });

  it('derives a stable opaque token and changes it on private decision drift', async () => {
    const lifecycle = await decisionLifecycle('recovery');
    const token = await publicDecisionActionTokenV1(
      lifecycle.decision,
      lifecycle.requestedRun.binding.sessionId
    );
    await expect(publicDecisionActionTokenV1(
      structuredClone(lifecycle.decision),
      lifecycle.requestedRun.binding.sessionId
    )).resolves.toBe(token);
    await expect(publicDecisionActionTokenV1({
      ...lifecycle.decision,
      uncertainty: 'different private uncertainty'
    }, lifecycle.requestedRun.binding.sessionId)).resolves.not.toBe(token);
    expect(token).toMatch(/^decision-action\.v1:[a-f0-9]{64}$/u);
    expect(token).not.toContain('private');
  });

  it('uses the complete immutable receipt when one Run version spans outbox pages', async () => {
    const lifecycle = await decisionLifecycle('plan');
    const request = requestArtifacts(lifecycle);
    const outbox = new FakeAgentRunOutboxStore(messagesFor([request]));
    const sink = new IdempotentPublicEventSink();
    let claimSequence = 0;
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader([request]),
      sink,
      {
        claimLimit: 1,
        claimIdFactory: () => `page-claim-${String(++claimSequence)}`
      }
    );

    await publisher.publishPending();
    await publisher.publishPending();
    expect(sink.appendCalls).toHaveLength(2);
    expect(sink.appendCalls[1]).toEqual(sink.appendCalls[0]);
    expect(sink.persisted.size).toBe(1);
    expect(sink.appendCalls[0]!.changes.map((change) => change.feature))
      .toEqual(['runs', 'decisions']);
    expect(outbox.publishedEventIds.size).toBe(2);
  });

  it('replays the exact atomic commit after append succeeds but ACK crashes', async () => {
    const lifecycle = await decisionLifecycle('permission');
    const request = requestArtifacts(lifecycle);
    const outbox = new FakeAgentRunOutboxStore(messagesFor([request]));
    outbox.failNextPublish = true;
    const sink = new IdempotentPublicEventSink();
    let claimSequence = 0;
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader([request]),
      sink,
      { claimIdFactory: () => `replay-claim-${String(++claimSequence)}` }
    );

    await expect(publisher.publishPending()).rejects.toThrow('simulated_ack_crash');
    expect(sink.appendCalls).toHaveLength(1);
    expect(outbox.publishedEventIds.size).toBe(0);

    await expect(publisher.publishPending()).resolves.toMatchObject({
      projectedVersions: 1,
      acknowledgedMessages: 2
    });
    expect(sink.appendCalls).toHaveLength(2);
    expect(sink.appendCalls[1]).toEqual(sink.appendCalls[0]);
    expect(sink.persisted.size).toBe(1);
    expect(outbox.publishedEventIds.size).toBe(2);
  });

  it('fails closed before append or ACK when an outbox payload drifts from its receipt', async () => {
    const lifecycle = await decisionLifecycle('plan');
    const request = requestArtifacts(lifecycle);
    const messages = messagesFor([request]);
    const first = messages[0]!;
    const tampered: OutboxMessage = {
      ...first,
      event: {
        ...first.event,
        payload: {
          type: 'run.cancelled',
          reason: 'tampered payload'
        }
      }
    };
    const outbox = new FakeAgentRunOutboxStore([tampered, ...messages.slice(1)]);
    const sink = new IdempotentPublicEventSink();
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader([request]),
      sink,
      { claimIdFactory: () => 'drift-claim' }
    );

    await expect(publisher.publishPending()).rejects.toThrow(
      'agent_run_projection_outbox_payload_drift'
    );
    expect(sink.appendCalls).toEqual([]);
    expect(outbox.publishCalls).toEqual([]);
  });

  it('uses the historical active Decision to resolve a version with no active decision', async () => {
    const lifecycle = await decisionLifecycle('plan');
    const resolution = resolutionArtifacts(lifecycle);
    const outbox = new FakeAgentRunOutboxStore(messagesFor([resolution]));
    const sink = new IdempotentPublicEventSink();
    const reader = new MapRunVersionReader([resolution], [lifecycle.requestedRun]);
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      reader,
      sink,
      { claimIdFactory: () => 'historical-decision-claim' }
    );

    await publisher.publishPending();
    expect(sink.appendCalls[0]!.changes[1]).toMatchObject({
      feature: 'decisions',
      aggregateId: lifecycle.decision.decisionId,
      dto: { status: 'rejected', requestedAt: lifecycle.decision.requestedAt }
    });
  });

  it('keeps terminal result projection before public append and ACK', async () => {
    const previous = queuedRun('run-terminal');
    const terminal = cancelledRun(previous);
    const artifacts = terminalArtifacts(terminal);
    const outbox = new FakeAgentRunOutboxStore(messagesFor([artifacts]));
    const sink = new IdempotentPublicEventSink();
    const publisher = new AgentRunPublicProjectionPublisher(
      outbox,
      new MapRunVersionReader([artifacts], [previous]),
      sink,
      {
        claimIdFactory: () => 'terminal-claim',
        terminalResultSink: {
          async projectTerminalResult(): Promise<never> {
            throw new Error('conversation_result_projection_failed');
          }
        }
      }
    );

    await expect(publisher.publishPending()).rejects.toThrow(
      'conversation_result_projection_failed'
    );
    expect(sink.appendCalls).toEqual([]);
    expect(outbox.publishCalls).toEqual([]);
  });

  it('retains fixed-length Run identities and explicit coordination labels', () => {
    const runId = 'r'.repeat(256);
    const queued = queuedRun(runId);
    expect(agentRunChangedPublicEventId(runId, 1))
      .toMatch(/^agent-run\.changed:[a-f0-9]{64}$/u);
    expect(agentRunProjectionSourceId(runId))
      .toMatch(/^agent-run:[a-f0-9]{64}$/u);
    expect(projectAgentRunV3({
      ...queued,
      version: 2,
      state: {
        status: 'waiting_children',
        checkpointVersion: 1,
        enteredAt: at(1),
        requiredChildRunIds: ['child-a'],
        terminalChildRunIds: []
      },
      updatedAt: at(1)
    })).toMatchObject({ status: 'waiting_children', label: 'Waiting for child runs' });
  });
});

interface DecisionLifecycle {
  readonly decision: AgentDecision;
  readonly resolution: AgentDecisionResolution;
  readonly requestedRun: AgentRun;
  readonly resolvedRun: AgentRun;
  readonly planVersion?: AgentPlanVersionCommit;
}

interface VersionArtifacts {
  readonly run: AgentRun;
  readonly commandId: string;
  readonly events: readonly AgentRunEvent[];
  readonly planVersion?: AgentPlanVersionCommit;
}

type OutboxMessage = Omit<
  ClaimedAgentRunOutboxMessage,
  'claimId' | 'leaseExpiresAt'
>;

class FakeAgentRunOutboxStore implements AgentRunOutboxStore {
  public readonly publishCalls: AgentRunOutboxPublishRequest[] = [];
  public readonly publishedEventIds = new Set<string>();
  public failNextPublish = false;

  public constructor(private readonly messages: readonly OutboxMessage[]) {}

  public async claimPending(
    request: AgentRunOutboxClaimRequest
  ): Promise<readonly ClaimedAgentRunOutboxMessage[]> {
    return this.messages
      .filter((message) => !this.publishedEventIds.has(message.eventId))
      .slice(0, request.limit)
      .map((message) => ({
        ...message,
        claimId: request.claimId,
        leaseExpiresAt: at(100)
      }));
  }

  public async markPublished(request: AgentRunOutboxPublishRequest): Promise<void> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('simulated_ack_crash');
    }
    this.publishCalls.push(request);
    request.messages.forEach((message) => this.publishedEventIds.add(message.eventId));
  }
}

class MapRunVersionReader implements AgentRunVersionReader {
  private readonly runs: ReadonlyMap<string, AgentRun>;
  private readonly receipts: ReadonlyMap<string, AgentRunCommandReceipt>;
  private readonly plans: ReadonlyMap<string, AgentPlanVersionCommit>;

  public constructor(
    artifacts: readonly VersionArtifacts[],
    additionalRuns: readonly AgentRun[] = []
  ) {
    this.runs = new Map([
      ...additionalRuns,
      ...artifacts.map((artifact) => artifact.run)
    ].map((run) => [runKey(run.runId, run.version), run]));
    this.receipts = new Map(artifacts.map((artifact) => [
      artifact.commandId,
      {
        commandId: artifact.commandId,
        mutations: [{
          runId: artifact.run.runId,
          resultingVersion: artifact.run.version,
          run: artifact.run,
          events: artifact.events
        }]
      }
    ]));
    this.plans = new Map(artifacts.flatMap((artifact) => (
      artifact.planVersion === undefined
        ? []
        : [[planKey(artifact.planVersion.ref), artifact.planVersion] as const]
    )));
  }

  public async loadRunVersion(runId: string, version: number): Promise<AgentRun | null> {
    return this.runs.get(runKey(runId, version)) ?? null;
  }

  public async loadCommittedCommandReceipt(
    commandId: string
  ): Promise<AgentRunCommandReceipt | null> {
    return this.receipts.get(commandId) ?? null;
  }

  public async loadPlanVersion(
    reference: AgentPlanReference
  ): Promise<AgentPlanVersionCommit | null> {
    return this.plans.get(planKey(reference)) ?? null;
  }
}

class IdempotentPublicEventSink implements PublicProjectionCommitSink {
  public readonly appendCalls: ProjectionCommitV3[] = [];
  public readonly persisted = new Map<string, ProjectionCommitV3>();

  public async append(event: ProjectionCommitV3): Promise<void> {
    this.appendCalls.push(event);
    const existing = this.persisted.get(event.eventId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`public_event_identity_conflict:${event.eventId}`);
      }
      return;
    }
    this.persisted.set(event.eventId, event);
  }
}

async function decisionLifecycle(
  kind: AgentDecision['kind']
): Promise<DecisionLifecycle> {
  const runId = `run-${kind}`;
  if (kind === 'permission') {
    const intended = effect(runId, { status: 'intended', intendedAt: at(0) });
    const decision: AgentDecision = {
      kind,
      decisionId: 'decision-permission',
      runId,
      checkpoint: { runId, version: 2 },
      requestedAt: at(1),
      effectId: intended.effectId,
      toolCallId: intended.toolCallId,
      capabilityIds: intended.capabilityIds,
      scope: intended.scope
    };
    const requestedRun = runWith(
      runId,
      2,
      {
        status: 'waiting',
        reason: 'tool_permission',
        checkpointVersion: 2,
        decision
      },
      [intended],
      at(1)
    );
    const resolution: AgentDecisionResolution = {
      kind,
      decisionId: decision.decisionId,
      checkpoint: decision.checkpoint,
      resolvedAt: at(2),
      effectId: decision.effectId,
      outcome: 'allow_once',
      approvedCapabilityIds: decision.capabilityIds
    };
    return {
      decision,
      resolution,
      requestedRun,
      resolvedRun: runWith(
        runId,
        3,
        { status: 'running', checkpointVersion: 3, enteredAt: at(2) },
        [{
          ...intended,
          state: {
            status: 'authorized',
            authorizedAt: at(2),
            attempt: 1,
            decisionId: decision.decisionId
          }
        }],
        at(2)
      )
    };
  }

  if (kind === 'plan') {
    const payload = {
      publicPresentation: {
        contractVersion: '1.0' as const,
        summary: 'Apply the reviewed refactoring in bounded stages.',
        impactSummary: 'The plan may read files, change workspace files, and run verification.',
        steps: [
          {
            title: 'Audit boundaries',
            summary: 'Read the relevant architecture and module contracts.',
            impact: 'read_only' as const
          },
          {
            title: 'Implement the slice',
            summary: 'Change only the reviewed workspace modules.',
            impact: 'workspace_change' as const
          }
        ]
      },
      privateExecutionData: {
        provider: 'provider-secret',
        internalNotes: 'must never enter the public projection'
      }
    };
    const planHash = await sha256AgentControlData(payload);
    const decision: AgentDecision = {
      kind,
      decisionId: 'decision-plan',
      runId,
      checkpoint: { runId, version: 2 },
      requestedAt: at(1),
      planId: 'plan-private',
      planVersion: 7,
      planHash
    };
    const requestedRun = runWith(
      runId,
      2,
      {
        status: 'waiting',
        reason: 'plan_approval',
        checkpointVersion: 2,
        decision
      },
      [],
      at(1)
    );
    const resolution: AgentDecisionResolution = {
      kind,
      decisionId: decision.decisionId,
      checkpoint: decision.checkpoint,
      resolvedAt: at(2),
      planId: decision.planId,
      planVersion: decision.planVersion,
      planHash: decision.planHash,
      outcome: 'reject'
    };
    return {
      decision,
      resolution,
      planVersion: {
        ref: {
          planId: decision.planId,
          version: decision.planVersion,
          contentHash: decision.planHash
        },
        runId,
        payload,
        createdAt: decision.requestedAt
      },
      requestedRun,
      resolvedRun: runWith(
        runId,
        3,
        { status: 'running', checkpointVersion: 3, enteredAt: at(2) },
        [],
        at(2)
      )
    };
  }

  const uncertain = effect(runId, {
    status: 'uncertain',
    observedAt: at(1),
    attempt: 1,
    reason: 'private effect uncertainty'
  });
  const decision: AgentDecision = {
    kind,
    decisionId: 'decision-recovery',
    runId,
    checkpoint: { runId, version: 2 },
    requestedAt: at(1),
    effectId: uncertain.effectId,
    uncertainty: 'inspect C:\\private\\recovery.txt with sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    allowedActions: ['retry', 'mark_failed']
  };
  const requestedRun = runWith(
    runId,
    2,
    {
      status: 'recovering',
      reason: 'uncertain_effect',
      checkpointVersion: 2,
      decision
    },
    [uncertain],
    at(1)
  );
  const resolution: AgentDecisionResolution = {
    kind,
    decisionId: decision.decisionId,
    checkpoint: decision.checkpoint,
    resolvedAt: at(2),
    effectId: decision.effectId,
    outcome: 'retry'
  };
  return {
    decision,
    resolution,
    requestedRun,
    resolvedRun: runWith(
      runId,
      3,
      { status: 'running', checkpointVersion: 3, enteredAt: at(2) },
      [{
        ...uncertain,
        state: {
          status: 'authorized',
          authorizedAt: at(2),
          attempt: 2,
          decisionId: decision.decisionId
        }
      }],
      at(2)
    )
  };
}

function requestArtifacts(lifecycle: DecisionLifecycle): VersionArtifacts {
  return {
    ...artifacts(
    lifecycle.requestedRun,
    `command-${lifecycle.decision.kind}-request`,
    [
      { type: 'decision.requested', decision: lifecycle.decision },
      {
        type: 'run.state_changed',
        from: 'running',
        to: lifecycle.requestedRun.state
      }
    ]
    ),
    ...(lifecycle.planVersion === undefined ? {} : { planVersion: lifecycle.planVersion })
  };
}

function resolutionArtifacts(lifecycle: DecisionLifecycle): VersionArtifacts {
  return {
    ...artifacts(
    lifecycle.resolvedRun,
    `command-${lifecycle.decision.kind}-resolve`,
    [
      {
        type: 'decision.resolved',
        decisionId: lifecycle.decision.decisionId,
        resolution: lifecycle.resolution
      },
      {
        type: 'run.state_changed',
        from: lifecycle.requestedRun.state.status,
        to: lifecycle.resolvedRun.state
      }
    ]
    ),
    ...(lifecycle.planVersion === undefined ? {} : { planVersion: lifecycle.planVersion })
  };
}

function terminalArtifacts(run: AgentRun): VersionArtifacts {
  return artifacts(run, 'command-terminal-cancel', [
    { type: 'run.cancelled', reason: 'user_cancelled' },
    { type: 'run.state_changed', from: 'queued', to: run.state }
  ]);
}

function artifacts(
  run: AgentRun,
  commandId: string,
  payloads: readonly AgentRunEventPayload[]
): VersionArtifacts {
  return {
    run,
    commandId,
    events: payloads.map((payload, index) => ({
      eventId: `event:${commandId}:${String(index + 1)}`,
      commandId,
      runId: run.runId,
      runVersion: run.version,
      sequence: index + 1,
      occurredAt: run.updatedAt,
      payload
    }))
  };
}

function messagesFor(artifactsList: readonly VersionArtifacts[]): OutboxMessage[] {
  let cursor = 0;
  return artifactsList.flatMap((version) => version.events.map((event) => ({
    cursor: ++cursor,
    eventId: event.eventId,
    event,
    createdAt: event.occurredAt,
    publishAttempts: 1
  })));
}

function runWith(
  runId: string,
  version: number,
  state: AgentRun['state'],
  effects: readonly AgentEffect[],
  updatedAt: string
): AgentRun {
  return {
    runId,
    version,
    binding: binding(runId),
    state,
    turns: [],
    effects,
    inbox: [],
    createdAt: at(0),
    updatedAt
  };
}

function queuedRun(runId: string): AgentRun {
  return runWith(
    runId,
    1,
    { status: 'queued', checkpointVersion: 0, queuedAt: at(0) },
    [],
    at(0)
  );
}

function cancelledRun(previous: AgentRun): AgentRun {
  return runWith(
    previous.runId,
    previous.version + 1,
    {
      status: 'cancelled',
      checkpointVersion: 1,
      cancelledAt: at(1),
      reason: 'user_cancelled'
    },
    [],
    at(1)
  );
}

function effect(
  runId: string,
  state: AgentEffect['state']
): AgentEffect {
  return {
    effectId: `effect-${runId}`,
    runId,
    toolCallId: `tool-call-${runId}`,
    tool: {
      catalogId: 'catalog-secret',
      revision: 1,
      digest: `sha256:${'e'.repeat(64)}`,
      toolName: 'private-tool',
      toolVersion: '1.0.0',
      providerId: 'ariadne.builtin',
      contractDigest: `sha256:${'f'.repeat(64)}`
    },
    idempotencyKey: `idempotency-${runId}`,
    capabilityIds: ['workspace.write'],
    scope: ['workspace-private'],
    inputDigest: `sha256:${'d'.repeat(64)}`,
    state
  };
}

function binding(runId: string): AgentRun['binding'] {
  return {
    bindingVersion: 3,
    sessionId: 'session-public',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: `message-public-${runId.slice(0, 200)}`,
      messageVersion: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-private',
      revision: 1,
      grantDigest: `sha256:${'b'.repeat(64)}`,
      access: 'write',
      scopeIds: ['workspace-private']
    },
    model: {
      providerId: 'provider-secret',
      modelId: 'model-secret',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-secret',
      revision: 1,
      permissionMode: 'ask'
    },
    capabilities: [{
      capabilityId: 'workspace.write',
      scopeIds: ['workspace-private']
    }],
    toolCatalog: {
      catalogId: 'catalog-secret',
      revision: 1,
      digest: `sha256:${'e'.repeat(64)}`,
      allowedToolNames: ['private-tool']
    },
    budget: {
      grantId: `grant-${runId.slice(0, 200)}`,
      runId,
      vector: {
        modelTurns: 12,
        toolCalls: 8,
        readCalls: 0,
        writeCalls: 8,
        shellCalls: 0,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function runKey(runId: string, version: number): string {
  return `${runId}\u0000${String(version)}`;
}

function planKey(reference: AgentPlanReference): string {
  return `${reference.planId}\u0000${String(reference.version)}\u0000${reference.contentHash}`;
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
