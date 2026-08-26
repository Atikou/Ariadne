import {
  AgentInferenceDispatchRecoveryRequiredError,
  type AgentInferenceDispatchResult,
  type AgentRun,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentFollowUpInferenceDispatchController,
  isOwnedAgentFollowUpInference
} from '../src/control/execution/AgentFollowUpInferenceDispatchController.js';
import type {
  AgentInferenceDispatcher
} from '../src/control/execution/AgentRunExecutionDispatchController.js';

describe('AgentFollowUpInferenceDispatchController', () => {
  it('owns only the latest initial Attempt caused by one exact Effect-result batch', async () => {
    const run = followUpRun();
    const committed = terminalFollowUpResult(run);
    const inference: AgentInferenceDispatcher = {
      dispatch: vi.fn(async () => committed)
    };
    const controller = new AgentFollowUpInferenceDispatchController(
      unitOfWork(run),
      inference
    );

    await expect(controller.dispatchOwned({
      runId: run.runId,
      turnId: 'turn-follow-up',
      attemptId: 'attempt-follow-up',
      expectedVersion: run.version,
      occurredAt: at(6)
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'completed',
      inferenceStatus: 'succeeded',
      result: { run: { state: { status: 'completed' } } }
    });

    expect(inference.dispatch).toHaveBeenCalledOnce();
    expect(inference.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.runId,
      turnId: 'turn-follow-up',
      attemptId: 'attempt-follow-up',
      expectedVersion: run.version,
      occurredAt: at(6)
    }), expect.any(AbortSignal));
    const commandId = vi.mocked(inference.dispatch).mock.calls[0]![0].commandId;

    const replayInference: AgentInferenceDispatcher = {
      dispatch: vi.fn(async () => committed)
    };
    await new AgentFollowUpInferenceDispatchController(
      unitOfWork(run),
      replayInference
    ).dispatchOwned({
      runId: run.runId,
      turnId: 'turn-follow-up',
      attemptId: 'attempt-follow-up',
      expectedVersion: run.version,
      occurredAt: at(6)
    }, new AbortController().signal);
    expect(vi.mocked(replayInference.dispatch).mock.calls[0]![0].commandId).toBe(commandId);
  });

  it('cannot claim the Conversation first-Turn execution-intent owner', async () => {
    const run = followUpRun();
    const firstTurn = run.turns[0]!;
    const firstAttempt = firstTurn.attempts[0]!;
    const initialOnly: AgentRun = {
      ...run,
      version: 1,
      state: {
        status: 'running',
        checkpointVersion: 1,
        enteredAt: at(0)
      },
      turns: [{
        ...firstTurn,
        attempts: [{
          ...firstAttempt,
          state: { status: 'intended', intendedAt: at(0) }
        }]
      }],
      effects: [],
      updatedAt: at(0)
    };
    const inference: AgentInferenceDispatcher = {
      dispatch: vi.fn(async () => terminalFollowUpResult(run))
    };
    expect(isOwnedAgentFollowUpInference(
      initialOnly,
      initialOnly.turns[0]!,
      initialOnly.turns[0]!.attempts[0]!
    )).toBe(false);

    await expect(new AgentFollowUpInferenceDispatchController(
      unitOfWork(initialOnly),
      inference
    ).dispatchOwned({
      runId: initialOnly.runId,
      turnId: 'turn-objective',
      attemptId: 'attempt-objective',
      expectedVersion: initialOnly.version,
      occurredAt: at(1)
    }, new AbortController().signal)).rejects.toThrow(
      /exact latest intended Effect-result Turn/u
    );
    expect(inference.dispatch).not.toHaveBeenCalled();
  });

  it('returns explicit recovery ownership without retrying an already crossed boundary', async () => {
    const run = followUpRun();
    const inference: AgentInferenceDispatcher = {
      dispatch: vi.fn(async () => {
        throw new AgentInferenceDispatchRecoveryRequiredError(
          run.runId,
          'turn-follow-up',
          'attempt-follow-up'
        );
      })
    };
    const controller = new AgentFollowUpInferenceDispatchController(
      unitOfWork(run),
      inference
    );

    await expect(controller.dispatchOwned({
      runId: run.runId,
      turnId: 'turn-follow-up',
      attemptId: 'attempt-follow-up',
      expectedVersion: run.version,
      occurredAt: at(6)
    }, new AbortController().signal)).resolves.toEqual({
      status: 'waiting_recovery',
      reason: 'inference_already_crossed_boundary'
    });
    expect(inference.dispatch).toHaveBeenCalledOnce();
  });

  it('rejects a dispatcher result outside the exact causal Turn', async () => {
    const run = followUpRun();
    const result = terminalFollowUpResult(run);
    const inference: AgentInferenceDispatcher = {
      dispatch: vi.fn(async () => ({
        ...result,
        attempt: { ...result.attempt, attemptId: 'attempt-drifted' }
      }))
    };

    await expect(new AgentFollowUpInferenceDispatchController(
      unitOfWork(run),
      inference
    ).dispatchOwned({
      runId: run.runId,
      turnId: 'turn-follow-up',
      attemptId: 'attempt-follow-up',
      expectedVersion: run.version,
      occurredAt: at(6)
    }, new AbortController().signal)).rejects.toThrow(/outside its exact causal Turn/u);
  });
});

function unitOfWork(run: AgentRun): AgentRunUnitOfWork {
  return {
    transaction: async (operation) => operation({
      loadRun: async () => structuredClone(run),
      loadCommittedCommand: async () => null,
      commitCommand: async () => undefined
    })
  };
}

function followUpRun(): AgentRun {
  const runId = 'run-follow-up-owner';
  const directiveDigest = digest('a');
  const inputDigest = digest('b');
  const tool = {
    catalogId: 'catalog-follow-up',
    revision: 1,
    digest: digest('c'),
    toolName: 'workspace.read',
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    contractDigest: digest('d')
  } as const;
  const binding: AgentRun['binding'] = {
    bindingVersion: 3,
    sessionId: 'session-follow-up',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: 'message-follow-up',
      messageVersion: 1,
      contentDigest: digest('e')
    },
    workspace: {
      workspaceId: 'workspace-follow-up',
      revision: 1,
      grantDigest: digest('f'),
      access: 'read',
      scopeIds: ['workspace.root']
    },
    model: {
      providerId: 'provider-follow-up',
      modelId: 'model-follow-up',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-follow-up',
      revision: 1,
      permissionMode: 'trusted'
    },
    capabilities: [{
      capabilityId: 'workspace.read',
      scopeIds: ['workspace.root']
    }],
    toolCatalog: {
      catalogId: tool.catalogId,
      revision: tool.revision,
      digest: tool.digest,
      allowedToolNames: [tool.toolName]
    },
    budget: {
      grantId: 'grant-follow-up',
      runId,
      vector: {
        modelTurns: 3,
        toolCalls: 1,
        readCalls: 1,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 10_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
  return {
    runId,
    version: 6,
    binding,
    state: {
      status: 'running',
      checkpointVersion: 6,
      enteredAt: at(5)
    },
    turns: [{
      turnId: 'turn-objective',
      runId,
      intention: {
        expectedRunVersion: null,
        checkpointVersion: 1,
        cause: {
          kind: 'conversation_objective',
          messageId: binding.objectiveRef.kind === 'conversation_message'
            ? binding.objectiveRef.messageId
            : 'unreachable',
          messageVersion: 1,
          contentDigest: digest('e')
        },
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: digest('1'),
        inputSummary: { messageCount: 1, toolCount: 1, contentCharacterCount: 9 }
      },
      attempts: [{
        attemptId: 'attempt-objective',
        turnId: 'turn-objective',
        runId,
        providerIdempotencyKey: 'provider-objective',
        cause: { kind: 'initial' },
        state: {
          status: 'succeeded',
          finishedAt: at(1),
          directive: {
            kind: 'invoke_tools',
            invocations: [{
              effectId: 'effect-follow-up',
              toolCallId: 'tool-call-follow-up',
              tool,
              idempotencyKey: 'effect-idempotency-follow-up',
              capabilityIds: ['workspace.read'],
              scope: ['workspace.root'],
              inputDigest
            }]
          },
          directiveDigest
        }
      }],
      createdAt: at(0)
    }, {
      turnId: 'turn-follow-up',
      runId,
      intention: {
        expectedRunVersion: 5,
        checkpointVersion: 6,
        cause: {
          kind: 'effect_results',
          sourceTurnId: 'turn-objective',
          sourceAttemptId: 'attempt-objective',
          sourceDirectiveDigest: directiveDigest,
          effectIds: ['effect-follow-up'],
          toolCallIds: ['tool-call-follow-up']
        },
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: digest('2'),
        inputSummary: { messageCount: 2, toolCount: 1, contentCharacterCount: 50 }
      },
      attempts: [{
        attemptId: 'attempt-follow-up',
        turnId: 'turn-follow-up',
        runId,
        providerIdempotencyKey: 'provider-follow-up',
        cause: { kind: 'initial' },
        state: { status: 'intended', intendedAt: at(5) }
      }],
      createdAt: at(5)
    }],
    effects: [{
      effectId: 'effect-follow-up',
      runId,
      toolCallId: 'tool-call-follow-up',
      tool,
      idempotencyKey: 'effect-idempotency-follow-up',
      capabilityIds: ['workspace.read'],
      scope: ['workspace.root'],
      inputDigest,
      origin: {
        turnId: 'turn-objective',
        attemptId: 'attempt-objective',
        directiveDigest
      },
      state: { status: 'succeeded', finishedAt: at(4), attempt: 1 }
    }],
    createdAt: at(0),
    updatedAt: at(5)
  };
}

function terminalFollowUpResult(previous: AgentRun): AgentInferenceDispatchResult {
  const turn = previous.turns[1]!;
  const attempt = {
    ...turn.attempts[0]!,
    state: {
      status: 'succeeded' as const,
      finishedAt: at(7),
      directive: { kind: 'complete' as const },
      directiveDigest: digest('9')
    }
  };
  const committedTurn = { ...turn, attempts: [attempt] };
  const run: AgentRun = {
    ...previous,
    version: 8,
    state: {
      status: 'completed',
      checkpointVersion: 8,
      completedAt: at(7)
    },
    turns: [previous.turns[0]!, committedTurn],
    updatedAt: at(7)
  };
  return {
    run,
    turn: committedTurn,
    attempt,
    command: null,
    status: 'succeeded',
    alreadySettled: false
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function at(second: number): string {
  return `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}
