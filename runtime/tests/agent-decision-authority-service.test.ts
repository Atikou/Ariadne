import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentPlanBudgetChildRunService,
  AgentRunCommandService,
  AgentRunVersionConflictError,
  digestAgentCommittedDirective,
  digestAgentTurnInput,
  getActiveDecision,
  sha256AgentControlData,
  summarizeAgentTurnInput,
  type AgentJsonValue,
  type AgentDecision,
  type AgentRun,
  type AgentRunCommand,
  type AgentRunCommandResult,
  type AgentRunCommitArtifacts
} from '@ariadne/agent-core';
import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  derivePublicDecisionActionDescriptorV1,
  type PublicDecisionChoiceV3
} from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import {
  AgentDecisionAuthorityError,
  AgentDecisionAuthorityService,
  type ResolvePublicAgentDecisionRequest
} from '../src/control/run/AgentDecisionAuthorityService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const roots: string[] = [];
const units = new Set<SqliteAgentRunUnitOfWork>();
const effectInputDigester = new Sha256AgentEffectInputDigester();

afterEach(async () => {
  for (const unit of units) {
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await unit.close(context);
    } finally {
      context.dispose();
    }
  }
  units.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AgentDecisionAuthorityService', () => {
  it.each([
    ['permission', 'allow_once'],
    ['plan', 'reject'],
    ['recovery', 'retry'],
    ['user_question', 'answer']
  ] as const)('resolves an authoritative %s request without accepting private payload', async (
    kind,
    choice
  ) => {
    const unit = createUnit();
    const active = await seedDecision(unit, kind);
    const service = new AgentDecisionAuthorityService(unit, () => new Date(at(20)));
    const request = await publicRequest(active, choice, `resolve-${kind}`);

    await expect(service.execute(request)).resolves.toEqual({
      kind: 'agent.decision.resolved.v3',
      runId: active.run.runId,
      decisionId: active.decision.decisionId,
      runVersion: active.run.version + 1
    });
    const receipt = await unit.loadCommittedCommandReceipt(request.commandId);
    expect(receipt?.mutations[0]?.events.some(
      (event) => event.payload.type === 'decision.resolved'
    )).toBe(true);
    expect(getActiveDecision(receipt!.mutations[0]!.run)).toBeNull();
    if (kind === 'user_question') {
      expect(receipt!.mutations[0]!.run.inbox).toMatchObject([{
        delivery: 'next_step',
        content: 'local: Local only',
        state: 'queued',
        source: {
          kind: 'user_question_answer',
          decisionId: active.decision.decisionId
        }
      }]);
    }
  });

  it('fails closed on token/choice drift and exactly replays and reconciles one receipt', async () => {
    const unit = createUnit();
    const active = await seedDecision(unit, 'permission');
    const now = vi.fn(() => new Date(at(20)));
    const service = new AgentDecisionAuthorityService(unit, now);
    const request = await publicRequest(active, 'allow_run', 'resolve-replay');
    const token = request.command.action.actionToken;

    await expect(service.execute({
      ...request,
      command: {
        ...request.command,
        action: {
          ...request.command.action,
          actionToken: `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
        }
      }
    })).rejects.toMatchObject({
      code: 'AGENT_DECISION_AUTHORITY_TOKEN_MISMATCH'
    });
    await expect(service.execute({
      ...request,
      commandId: 'resolve-invalid-choice',
      command: {
        ...request.command,
        action: { ...request.command.action, choice: 'approve' }
      }
    })).rejects.toMatchObject({
      code: 'AGENT_DECISION_AUTHORITY_CHOICE_INVALID'
    });

    const first = await service.execute(request);
    await expect(service.execute(request)).resolves.toEqual(first);
    await expect(service.reconcile(request)).resolves.toEqual(first);
    expect(now).toHaveBeenCalledTimes(1);
    await expect(service.execute({
      ...request,
      command: {
        ...request.command,
        action: { ...request.command.action, choice: 'deny' }
      }
    })).rejects.toBeInstanceOf(AgentDecisionAuthorityError);
  });

  it('coalesces concurrent identical command IDs into one exact commit', async () => {
    const unit = createUnit();
    const active = await seedDecision(unit, 'plan');
    const now = vi.fn(() => new Date(at(20)));
    const service = new AgentDecisionAuthorityService(unit, now);
    const request = await publicRequest(active, 'approve', 'resolve-concurrent-same');

    const [left, right] = await Promise.all([
      service.execute(request),
      service.execute(request)
    ]);
    expect(right).toEqual(left);
    expect(now).toHaveBeenCalledTimes(1);
    expect((await unit.loadCommittedCommandReceipt(request.commandId))?.mutations)
      .toHaveLength(1);
  });

  it('uses Agent Core CAS when different command IDs race on one active Decision', async () => {
    const unit = createUnit();
    const active = await seedDecision(unit, 'plan');
    const service = new AgentDecisionAuthorityService(unit, () => new Date(at(20)));
    const approve = await publicRequest(active, 'approve', 'resolve-cas-approve');
    const reject = await publicRequest(active, 'reject', 'resolve-cas-reject');

    const outcomes = await Promise.allSettled([
      service.execute(approve),
      service.execute(reject)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(AgentRunVersionConflictError);
    }
  });

  it('reopens a waiting user question and resolves it from the same durable authority', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ariadne-decision-authority-reopen-'));
    roots.push(root);
    const first = new SqliteAgentRunUnitOfWork(root);
    units.add(first);
    const seeded = await seedDecision(first, 'user_question');
    const closeContext = createShutdownContext(Date.now() + 5_000);
    try {
      await first.close(closeContext);
    } finally {
      closeContext.dispose();
      units.delete(first);
    }

    const reopened = new SqliteAgentRunUnitOfWork(root);
    units.add(reopened);
    const run = await reopened.transaction((transaction) => (
      transaction.loadRun(seeded.run.runId)
    ));
    const decision = run === null ? null : getActiveDecision(run);
    expect(run?.state).toMatchObject({
      status: 'waiting',
      reason: 'user_question',
      decision: { decisionId: seeded.decision.decisionId }
    });
    if (run === null || decision === null) throw new Error('reopened question missing');

    const request = await publicRequest(
      { run, decision },
      'answer',
      'resolve-reopened-user-question'
    );
    await expect(new AgentDecisionAuthorityService(
      reopened,
      () => new Date(at(20))
    ).execute(request)).resolves.toMatchObject({
      kind: 'agent.decision.resolved.v3',
      runId: run.runId,
      decisionId: decision.decisionId,
      runVersion: run.version + 1
    });
  });

  it('resolves a pending question after decision-neutral inbox versions advance the Run', async () => {
    const unit = createUnit();
    const seeded = await seedDecision(unit, 'user_question');
    const content = 'queued while the question remains pending';
    const commands = new AgentRunCommandService(unit);
    const enqueued = await commands.execute({
      kind: 'run.enqueue_inbox_input',
      commandId: 'enqueue-before-question-answer',
      runId: seeded.run.runId,
      expectedVersion: seeded.run.version,
      occurredAt: at(10),
      input: {
        inputId: 'input-before-question-answer',
        messageId: 'message-before-question-answer',
        delivery: 'next_turn',
        content,
        contentDigest: await sha256AgentControlData(content)
      }
    }, { turnInputPayloads: [], effectPayloads: [] });
    const removed = await commands.execute({
      kind: 'run.remove_inbox_input',
      commandId: 'remove-before-question-answer',
      runId: seeded.run.runId,
      expectedVersion: enqueued.run.version,
      occurredAt: at(11),
      inputId: 'input-before-question-answer',
      expectedInputVersion: 1
    }, { turnInputPayloads: [], effectPayloads: [] });
    const decision = getActiveDecision(removed.run);
    if (decision === null) throw new Error('pending question missing after inbox mutations');
    const request = await publicRequest(
      { run: removed.run, decision },
      'answer',
      'resolve-after-inbox-versions'
    );

    await expect(new AgentDecisionAuthorityService(
      unit,
      () => new Date(at(20))
    ).execute(request)).resolves.toMatchObject({
      kind: 'agent.decision.resolved.v3',
      runId: removed.run.runId,
      decisionId: decision.decisionId,
      runVersion: removed.run.version + 1
    });
  });
});

async function seedDecision(
  unit: SqliteAgentRunUnitOfWork,
  kind: AgentDecision['kind']
): Promise<{ readonly run: AgentRun; readonly decision: AgentDecision }> {
  const runId = `run-authority-${kind}`;
  const commands = new DecisionFixtureCommandService(unit);
  await commands.execute({
    kind: 'run.start',
    commandId: `start-${kind}`,
    runId,
    occurredAt: at(0),
    binding: binding(runId)
  });
  await commands.execute({
    kind: 'run.begin',
    commandId: `begin-${kind}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(1)
  });

  if (kind === 'plan') {
    const payload = {
      title: 'Private authority plan',
      steps: [{ stepId: 'private-step', body: 'Do not project this body.' }]
    };
    const contentHash = await sha256AgentControlData(payload);
    await new AgentPlanBudgetChildRunService(unit).createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'request-plan',
      runId,
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-authority-plan',
      plan: {
        ref: {
          planId: 'plan-authority-private',
          version: 1,
          contentHash
        },
        payload
      }
    });
  } else if (kind === 'user_question') {
    const input = {
      messages: [{ kind: 'text' as const, role: 'user' as const, content: 'Choose a target.' }],
      availableTools: questionAvailableTools()
    };
    const inputDigest = await digestAgentTurnInput(input);
    await commands.execute({
      kind: 'run.register_turn',
      commandId: 'register-user-question-turn',
      runId,
      expectedVersion: 2,
      occurredAt: at(2),
      turn: {
        cause: {
          kind: 'conversation_objective',
          messageId: binding(runId).objectiveRef.kind === 'conversation_message'
            ? binding(runId).objectiveRef.messageId
            : 'invalid-objective',
          messageVersion: 1,
          contentDigest: binding(runId).objectiveRef.contentDigest
        },
        turnId: 'turn-user-question',
        attemptId: 'attempt-user-question',
        providerIdempotencyKey: 'provider-user-question',
        inputDigest,
        inputSummary: summarizeAgentTurnInput(input)
      }
    });
    await commands.execute({
      kind: 'run.start_inference_attempt',
      commandId: 'start-user-question-attempt',
      runId,
      expectedVersion: 3,
      occurredAt: at(3),
      turnId: 'turn-user-question',
      attemptId: 'attempt-user-question'
    });
    const payload = {
      format: 'ariadne.user-question' as const,
      schemaVersion: 1 as const,
      prompt: 'Which deployment target should be used?',
      options: [
        { optionId: 'local', label: 'Local only' },
        { optionId: 'remote', label: 'Remote host' }
      ]
    };
    const questionDigest = await sha256AgentControlData(payload);
    const directive = {
      kind: 'ask_user' as const,
      decisionId: 'decision-authority-user-question',
      questionRef: 'question-authority-user-question',
      questionDigest
    };
    await commands.execute({
      kind: 'run.record_inference_attempt_result',
      commandId: 'record-user-question-result',
      runId,
      expectedVersion: 4,
      occurredAt: at(4),
      turnId: 'turn-user-question',
      attemptId: 'attempt-user-question',
      result: {
        status: 'succeeded',
        directive,
        directiveDigest: await digestAgentCommittedDirective(directive)
      }
    });
  } else {
    await commands.execute({
      kind: 'run.register_effect',
      commandId: `register-effect-${kind}`,
      runId,
      expectedVersion: 2,
      occurredAt: at(2),
      effect: effectDraft(kind)
    });
    if (kind === 'permission') {
      await commands.execute({
        kind: 'run.request_decision',
        commandId: 'request-permission',
        runId,
        expectedVersion: 3,
        occurredAt: at(3),
        decision: {
          kind: 'permission',
          decisionId: 'decision-authority-permission',
          requestedAt: at(3),
          effectId: `effect-${kind}`,
          toolCallId: `tool-call-${kind}`,
          capabilityIds: ['workspace.write'],
          scope: ['workspace']
        }
      });
    } else {
      await commands.execute({
        kind: 'run.authorize_effect',
        commandId: 'authorize-effect-recovery',
        runId,
        expectedVersion: 3,
        occurredAt: at(3),
        effectId: 'effect-recovery'
      });
      await commands.execute({
        kind: 'run.start_effect',
        commandId: 'start-effect-recovery',
        runId,
        expectedVersion: 4,
        occurredAt: at(4),
        effectId: 'effect-recovery'
      });
      await commands.execute({
        kind: 'run.record_effect_result',
        commandId: 'uncertain-effect-recovery',
        runId,
        expectedVersion: 5,
        occurredAt: at(5),
        effectId: 'effect-recovery',
        result: {
          status: 'uncertain',
          reason: 'C:\\private\\effect.txt sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
          recoveryDecisionId: 'decision-authority-recovery',
          allowedActions: ['retry', 'mark_failed']
        }
      });
    }
  }

  const run = await unit.transaction((transaction) => transaction.loadRun(runId));
  const decision = run === null ? null : getActiveDecision(run);
  if (run === null || decision === null) throw new Error('decision_seed_failed');
  return { run, decision };
}

async function publicRequest(
  active: { readonly run: AgentRun; readonly decision: AgentDecision },
  choice: PublicDecisionChoiceV3,
  commandId: string
): Promise<ResolvePublicAgentDecisionRequest> {
  const action = await derivePublicDecisionActionDescriptorV1(
    active.decision,
    active.run.binding.sessionId
  );
  return {
    commandId,
    signal: new AbortController().signal,
    command: {
      kind: 'agent.decision.resolve.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: active.run.runId,
      decisionId: active.decision.decisionId,
      action: {
        contractVersion: action.contractVersion,
        actionToken: action.actionToken,
        choice,
        ...(choice === 'answer' ? { answer: 'local: Local only' } : {})
      }
    }
  };
}

function effectDraft(kind: 'permission' | 'recovery') {
  const runId = `run-authority-${kind}`;
  const effectId = `effect-${kind}`;
  return {
    effectId,
    toolCallId: `tool-call-${kind}`,
    tool: {
      catalogId: 'catalog-private',
      revision: 1,
      digest: `sha256:${'d'.repeat(64)}`,
      toolName: 'private-tool',
      toolVersion: '1.0.0',
      providerId: 'ariadne.builtin',
      contractDigest: `sha256:${'e'.repeat(64)}`
    },
    idempotencyKey: `idempotency-${kind}`,
    capabilityIds: ['workspace.write'],
    scope: ['workspace'],
    inputDigest: effectInputDigester.digest(effectInput(effectId), { runId, effectId })
  };
}

class DecisionFixtureCommandService extends AgentRunCommandService {
  public override async execute(command: AgentRunCommand): Promise<AgentRunCommandResult> {
    return super.execute(command, await fixtureArtifacts(command));
  }
}

async function fixtureArtifacts(command: AgentRunCommand): Promise<AgentRunCommitArtifacts> {
  const effectPayloads: AgentRunCommitArtifacts['effectPayloads'] =
    command.kind === 'run.register_effect'
      ? [{
          kind: 'record_input',
          effectId: command.effect.effectId,
          inputDigest: command.effect.inputDigest,
          input: effectInput(command.effect.effectId),
          recordedAt: command.occurredAt
        }]
      : [];
  const terminal = command.kind === 'run.complete'
    || command.kind === 'run.fail'
    || command.kind === 'run.cancel';
  return {
    turnInputPayloads: command.kind === 'run.register_turn'
      ? [{
          turnId: command.turn.turnId,
          inputDigest: command.turn.inputDigest,
          recordedAt: command.occurredAt,
          payload: {
            format: 'ariadne.agent-turn-input',
            schemaVersion: 1,
            runId: command.runId,
            turnId: command.turn.turnId,
            cause: command.turn.cause,
            authorityRef: {
              kind: 'conversation_message',
              sessionId: binding(command.runId).sessionId,
              workspaceId: binding(command.runId).workspace.workspaceId,
              messageId: binding(command.runId).objectiveRef.kind === 'conversation_message'
                ? binding(command.runId).objectiveRef.messageId
                : 'invalid-objective',
              messageVersion: 1,
              contentDigest: binding(command.runId).objectiveRef.contentDigest
            },
            messages: [{ kind: 'text', role: 'user', content: 'Choose a target.' }],
            availableTools: questionAvailableTools()
          }
        }]
      : [],
    effectPayloads,
    directivePayloads:
      command.kind === 'run.record_inference_attempt_result'
      && command.result.status === 'succeeded'
      && command.result.directive.kind === 'ask_user'
        ? [{
            artifactId: command.result.directive.questionRef,
            kind: 'user_question',
            directiveDigest: command.result.directiveDigest,
            contentDigest: command.result.directive.questionDigest,
            payload: {
              format: 'ariadne.user-question',
              schemaVersion: 1,
              prompt: 'Which deployment target should be used?',
              options: [
                { optionId: 'local', label: 'Local only' },
                { optionId: 'remote', label: 'Remote host' }
              ]
            },
            recordedAt: command.occurredAt
          }]
        : [],
    ...(command.kind !== 'run.start' && !terminal
      ? {
          checkpoint: {
            checkpointVersion: command.expectedVersion,
            payload: {
              format: 'ariadne.agent-checkpoint' as const,
              schemaVersion: 1 as const,
              engineContinuation: { commandId: command.commandId },
              modelContext: [{ role: 'system', content: 'authority fixture' }]
            },
            createdAt: command.occurredAt
          }
        }
      : {})
  };
}

function effectInput(effectId: string): AgentJsonValue {
  return {
    tool: 'private-tool',
    effectId,
    payload: 'private authority fixture'
  };
}

function questionAvailableTools() {
  return [{
    tool: {
      catalogId: 'catalog-private',
      revision: 1,
      digest: `sha256:${'d'.repeat(64)}`,
      toolName: 'private-tool',
      toolVersion: '1.0.0',
      providerId: 'ariadne.builtin',
      contractDigest: `sha256:${'e'.repeat(64)}`
    },
    capabilityIds: ['workspace.write']
  }];
}

function binding(runId: string): AgentRun['binding'] {
  return {
    bindingVersion: 3,
    sessionId: `session-${runId}`,
    objectiveRef: {
      kind: 'conversation_message',
      messageId: `message-${runId}`,
      messageVersion: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-authority',
      revision: 1,
      grantDigest: `sha256:${'b'.repeat(64)}`,
      access: 'write',
      scopeIds: ['workspace']
    },
    model: { providerId: 'provider-private', modelId: 'model-private', settingsRevision: 1 },
    policy: { policyId: 'policy-private', revision: 1, permissionMode: 'ask' },
    capabilities: [{ capabilityId: 'workspace.write', scopeIds: ['workspace'] }],
    toolCatalog: {
      catalogId: 'catalog-private',
      revision: 1,
      digest: `sha256:${'d'.repeat(64)}`,
      allowedToolNames: ['private-tool']
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector: {
        modelTurns: 10,
        toolCalls: 10,
        readCalls: 0,
        writeCalls: 10,
        shellCalls: 0,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

function createUnit(): SqliteAgentRunUnitOfWork {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-decision-authority-'));
  roots.push(root);
  const unit = new SqliteAgentRunUnitOfWork(root);
  units.add(unit);
  return unit;
}

function at(seconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString();
}
