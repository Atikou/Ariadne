import { describe, expect, it } from 'vitest';
import {
  AgentEffectTransitionError,
  type AgentEffect,
  transitionAgentEffect
} from '../src/index.js';
import {
  TEST_EFFECT_INPUT_DIGEST,
  testPinnedToolIdentity
} from './fixtures.js';

const effect: AgentEffect = {
  effectId: 'effect-1',
  runId: 'run-1',
  toolCallId: 'tool-call-1',
  tool: testPinnedToolIdentity('workspace.write'),
  idempotencyKey: 'run-1:tool-call-1',
  capabilityIds: ['workspace.write'],
  scope: ['src/a.ts'],
  inputDigest: TEST_EFFECT_INPUT_DIGEST,
  state: {
    status: 'intended',
    intendedAt: '2026-07-31T00:00:00.000Z'
  }
};

describe('AgentEffect state machine', () => {
  it('requires intention, authorization and start before success', () => {
    expect(() => transitionAgentEffect(effect, {
      type: 'succeed',
      at: '2026-07-31T00:00:01.000Z'
    })).toThrow(AgentEffectTransitionError);

    const authorized = transitionAgentEffect(effect, {
      type: 'authorize',
      at: '2026-07-31T00:00:01.000Z'
    });
    const started = transitionAgentEffect(authorized, {
      type: 'start',
      at: '2026-07-31T00:00:02.000Z'
    });
    const succeeded = transitionAgentEffect(started, {
      type: 'succeed',
      at: '2026-07-31T00:00:03.000Z'
    });

    expect(succeeded.state.status).toBe('succeeded');
    expect(() => transitionAgentEffect(succeeded, {
      type: 'cancel',
      at: '2026-07-31T00:00:04.000Z',
      reason: 'too_late'
    })).toThrow(AgentEffectTransitionError);
  });

  it('preserves uncertainty and advances the attempt only after explicit recovery', () => {
    const authorized = transitionAgentEffect(effect, {
      type: 'authorize',
      at: '2026-07-31T00:00:01.000Z'
    });
    const started = transitionAgentEffect(authorized, {
      type: 'start',
      at: '2026-07-31T00:00:02.000Z'
    });
    const uncertain = transitionAgentEffect(started, {
      type: 'mark_uncertain',
      at: '2026-07-31T00:00:03.000Z',
      reason: 'No acknowledgement received.'
    });
    expect(uncertain.state).toMatchObject({
      status: 'uncertain',
      attempt: 1
    });
    expect(() => transitionAgentEffect(uncertain, {
      type: 'start',
      at: '2026-07-31T00:00:04.000Z'
    })).toThrow(AgentEffectTransitionError);

    const retryAuthorized = transitionAgentEffect(uncertain, {
      type: 'authorize',
      at: '2026-07-31T00:00:05.000Z',
      decisionId: 'decision-recovery-1'
    });
    expect(retryAuthorized.state).toMatchObject({
      status: 'authorized',
      attempt: 2,
      decisionId: 'decision-recovery-1'
    });
  });
});
