import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentPlanBudgetChildRunService,
  AgentRunCommandService,
  AgentRunVersionConflictError,
  getActiveDecision,
  sha256AgentControlData,
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
    ['recovery', 'retry']
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
        choice
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
  public override execute(command: AgentRunCommand): Promise<AgentRunCommandResult> {
    return super.execute(command, fixtureArtifacts(command));
  }
}

function fixtureArtifacts(command: AgentRunCommand): AgentRunCommitArtifacts {
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
    turnInputPayloads: [],
    effectPayloads,
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
