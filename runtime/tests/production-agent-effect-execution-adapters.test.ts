import {
  AgentRunInvariantError,
  type AgentEffect,
  type AgentEffectExecutionInput,
  type AgentJsonValue,
  type AgentRun
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  V3AgentEffectDispatchCheckpointFactory
} from '../src/control/execution/AgentEffectDispatchCheckpointFactory.js';
import {
  ProductionAgentEffectExecutionInputReader
} from '../src/control/execution/ProductionAgentEffectExecutionInputReader.js';
import type {
  AgentEffectExecutionInputSource
} from '../src/control/ports/AgentEffectExecutionInputSource.js';

const RUN_ID = 'run-effect-input-v3';
const EFFECT_ID = 'effect-input-v3';
const INPUT_DIGEST = `sha256:${'e'.repeat(64)}`;
const INPUT: AgentJsonValue = {
  path: 'src/output.ts',
  content: 'protected-effect-input'
};

describe('ProductionAgentEffectExecutionInputReader', () => {
  it('returns only the exact Effect execution input bound to the durable aggregate', async () => {
    const run = runningRun();
    const { unitOfWork, loadEffectExecutionInput } = unitFixture(run, payload());
    const reader = new ProductionAgentEffectExecutionInputReader(unitOfWork);

    await expect(reader.loadEffectExecutionInput(RUN_ID, EFFECT_ID)).resolves.toEqual({
      runId: RUN_ID,
      effectId: EFFECT_ID,
      inputDigest: INPUT_DIGEST,
      input: INPUT
    } satisfies AgentEffectExecutionInput);
    expect(loadEffectExecutionInput).toHaveBeenCalledWith(RUN_ID, EFFECT_ID);
  });

  it('fails closed when the Run or exact Effect is absent', async () => {
    const missingRun = unitFixture(null, payload());
    await expect(new ProductionAgentEffectExecutionInputReader(
      missingRun.unitOfWork
    ).loadEffectExecutionInput(RUN_ID, EFFECT_ID)).rejects.toThrow(
      'The execution input Run does not exist.'
    );
    expect(missingRun.loadEffectExecutionInput).not.toHaveBeenCalled();

    const missingEffect = unitFixture({ ...runningRun(), effects: [] }, payload());
    await expect(new ProductionAgentEffectExecutionInputReader(
      missingEffect.unitOfWork
    ).loadEffectExecutionInput(RUN_ID, EFFECT_ID)).rejects.toThrow(
      'The execution input does not match the exact Effect identity.'
    );
    expect(missingEffect.loadEffectExecutionInput).not.toHaveBeenCalled();
  });

  it('rejects Run, Effect, and input-digest identity drift', async () => {
    const driftedRun = unitFixture(runningRun('run-drifted-v3'), payload());
    await expect(new ProductionAgentEffectExecutionInputReader(
      driftedRun.unitOfWork
    ).loadEffectExecutionInput(RUN_ID, EFFECT_ID)).rejects.toThrow(
      'The execution input does not match the exact Run identity.'
    );

    for (const driftedPayload of [
      payload({ runId: 'run-drifted-v3' }),
      payload({ effectId: 'effect-drifted-v3' }),
      payload({ inputDigest: `sha256:${'f'.repeat(64)}` })
    ]) {
      const fixture = unitFixture(runningRun(), driftedPayload);
      await expect(new ProductionAgentEffectExecutionInputReader(
        fixture.unitOfWork
      ).loadEffectExecutionInput(RUN_ID, EFFECT_ID)).rejects.toThrow(
        'The protected Effect input differs from the exact Run, Effect, or input digest.'
      );
    }
  });
});

describe('V3AgentEffectDispatchCheckpointFactory', () => {
  it.each(['effect_started', 'effect_result'] as const)(
    'creates a bounded %s continuation without Effect input or result bodies',
    (phase) => {
      const run = runningRun();
      const effect = run.effects[0]!;
      const checkpoint = new V3AgentEffectDispatchCheckpointFactory().create({
        run,
        effect,
        checkpointVersion: 4,
        phase,
        occurredAt: '2030-01-01T00:00:04.000Z'
      });

      expect(checkpoint).toEqual({
        checkpointVersion: 4,
        createdAt: '2030-01-01T00:00:04.000Z',
        payload: {
          format: 'ariadne.agent-checkpoint',
          schemaVersion: 1,
          engineContinuation: {
            phase,
            effectId: EFFECT_ID,
            inputDigest: INPUT_DIGEST
          },
          modelContext: null
        }
      });
      const serialized = JSON.stringify(checkpoint);
      expect(serialized).not.toContain('protected-effect-input');
      expect(serialized).not.toContain('effect-result-secret');
      expect(Object.keys(checkpoint.payload.engineContinuation)).toEqual([
        'phase',
        'effectId',
        'inputDigest'
      ]);
    }
  );
});

function unitFixture(
  run: AgentRun | null,
  executionInput: ReturnType<typeof payload>
): {
  unitOfWork: AgentEffectExecutionInputSource;
  loadEffectExecutionInput: ReturnType<typeof vi.fn>;
} {
  const loadEffectExecutionInput = vi.fn(async () => executionInput);
  const unitOfWork = {
    transaction: async (operation: (transaction: {
      loadRun(runId: string): Promise<AgentRun | null>;
    }) => Promise<unknown>) => operation({
      loadRun: async () => run
    }),
    loadEffectExecutionInput
  } as unknown as AgentEffectExecutionInputSource;
  return { unitOfWork, loadEffectExecutionInput };
}

function payload(overrides: Partial<{
  runId: string;
  effectId: string;
  inputDigest: string;
  input: AgentJsonValue;
}> = {}) {
  return {
    runId: RUN_ID,
    effectId: EFFECT_ID,
    inputDigest: INPUT_DIGEST,
    input: INPUT,
    createdAt: '2030-01-01T00:00:02.000Z',
    updatedAt: '2030-01-01T00:00:02.000Z',
    ...overrides
  };
}

function runningRun(runId = RUN_ID): AgentRun {
  const effect: AgentEffect = {
    effectId: EFFECT_ID,
    runId,
    toolCallId: 'tool-call-effect-v3',
    tool: {
      catalogId: 'catalog-effect-v3',
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      toolName: 'workspace.write',
      toolVersion: '1.0.0',
      providerId: 'ariadne.builtin',
      contractDigest: `sha256:${'b'.repeat(64)}`
    },
    idempotencyKey: 'effect-idempotency-v3',
    capabilityIds: ['workspace.write'],
    scope: ['src'],
    inputDigest: INPUT_DIGEST,
    state: {
      status: 'authorized',
      authorizedAt: '2030-01-01T00:00:03.000Z',
      attempt: 1
    }
  };
  return {
    runId,
    version: 4,
    binding: {
      bindingVersion: 3,
      sessionId: 'session-effect-v3',
      objectiveRef: {
        kind: 'conversation_message',
        messageId: 'message-effect-v3',
        messageVersion: 1,
        contentDigest: `sha256:${'c'.repeat(64)}`
      },
      workspace: {
        workspaceId: 'workspace-effect-v3',
        revision: 1,
        grantDigest: `sha256:${'d'.repeat(64)}`,
        access: 'write',
        scopeIds: ['src']
      },
      model: {
        providerId: 'provider-effect-v3',
        modelId: 'model-effect-v3',
        settingsRevision: 1
      },
      policy: {
        policyId: 'policy-effect-v3',
        revision: 1,
        permissionMode: 'ask'
      },
      capabilities: [{
        capabilityId: 'workspace.write',
        scopeIds: ['src']
      }],
      toolCatalog: {
        catalogId: 'catalog-effect-v3',
        revision: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        allowedToolNames: ['workspace.write']
      },
      budget: {
        grantId: 'grant-effect-v3',
        runId,
        vector: {
          modelTurns: 3,
          toolCalls: 2,
          readCalls: 0,
          writeCalls: 2,
          shellCalls: 0,
          costMicrousd: 100_000
        },
        deadlineAt: '2031-01-01T00:00:00.000Z',
        source: { kind: 'root' }
      }
    },
    state: {
      status: 'running',
      checkpointVersion: 3,
      enteredAt: '2030-01-01T00:00:01.000Z'
    },
    turns: [],
    effects: [effect],
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:03.000Z'
  };
}
