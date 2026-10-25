import { describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import {
  AgentInputDeliveryTracker
} from '../src/renderer/src/core/runtime/agent-input-delivery';
import { NOW } from './projection-v3-fixture';

describe('Agent input delivery presentation state', () => {
  it('requires the exact Run, Session, input and delivery identity and never infers acceptance from omission', () => {
    const tracker = new AgentInputDeliveryTracker();
    const command = { kind: 'agent.inbox.enqueue' as const, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-delivery', sessionId: 'session-a', inputId: 'same-input', delivery: 'next_step' as const, content: 'Exact input' };
    tracker.begin('exact-command', command, NOW);
    tracker.requireReconciliation('exact-command', 'unknown', NOW);
    const input = { inputId: command.inputId, messageId: 'message-a', version: 1, delivery: command.delivery,
      state: 'queued' as const, queuedAt: NOW, updatedAt: NOW };
    const exact = { runId: command.runId, sessionId: command.sessionId, runVersion: 5, input };
    for (const candidates of [[], [{ ...exact, runId: 'other-run' }], [{ ...exact, sessionId: 'other-session' }],
      [{ ...exact, input: { ...input, delivery: 'next_turn' as const } }], [{ ...exact, input: null }],
      [{ ...exact, runVersion: 0 }], [{ ...exact, input: { ...input, version: 0 } }],
      [{ ...exact, input: { ...input, source: { kind: 'live_work' as const, jobId: 'job-a', workKind: 'fixture', status: 'completed' as const } } }]]) {
      expect(tracker.observeInboxIdentities(candidates)).toEqual([]);
      expect(tracker.snapshot()[0]?.state).toBe('reconcile');
    }
    expect(tracker.observeInboxIdentities([exact])).toEqual(['exact-command']);
    expect(tracker.snapshot()[0]?.state).toBe('accepted');
  });
  it('defers to the authoritative inbox projection and settles as accepted', () => {
    const tracker = new AgentInputDeliveryTracker();
    const command = {
      kind: 'agent.inbox.enqueue' as const,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-delivery',
      sessionId: 'session-a',
      inputId: 'input-delivery',
      delivery: 'next_step' as const,
      content: 'Continue after the current effect.'
    };
    tracker.begin('command-delivery', command, NOW);
    tracker.requireReconciliation('command-delivery', 'Outcome unknown.', NOW);

    expect(tracker.observeInboxIdentities([{
      runId: command.runId, sessionId: command.sessionId, runVersion: 5,
      input: {
        inputId: command.inputId,
        messageId: 'message-delivery',
        version: 1,
        delivery: command.delivery,
        state: 'queued',
        queuedAt: NOW,
        updatedAt: NOW
      }
    }])).toEqual(['command-delivery']);

    expect(tracker.snapshot()).toEqual([
      expect.objectContaining({
        commandId: 'command-delivery',
        inputId: 'input-delivery',
        state: 'accepted'
      })
    ]);
  });

  it('restores an unsettled sender record as reconcile without changing its identity', () => {
    const tracker = new AgentInputDeliveryTracker();
    const command = {
      kind: 'agent.inbox.enqueue' as const,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-delivery',
      sessionId: 'session-a',
      inputId: 'input-restored',
      delivery: 'next_turn' as const,
      content: 'Recover this exact command.'
    };

    expect(tracker.restore(
      'command-restored',
      command,
      '2026-07-30T23:59:00.000Z',
      NOW
    )).toMatchObject({
      commandId: 'command-restored',
      inputId: 'input-restored',
      state: 'reconcile',
      attempt: 1,
      createdAt: '2026-07-30T23:59:00.000Z'
    });
    expect(tracker.command('command-restored')).toEqual(command);
  });

  it('reuses the exact command payload and increments only the attempt counter', () => {
    const tracker = new AgentInputDeliveryTracker();
    const command = {
      kind: 'agent.inbox.enqueue' as const,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-delivery',
      sessionId: 'session-a',
      inputId: 'input-delivery',
      delivery: 'next_turn' as const,
      content: 'Do not create a duplicate input.'
    };
    tracker.begin('command-delivery', command, NOW);
    tracker.requireReconciliation('command-delivery', 'Outcome unknown.', NOW);

    expect(tracker.beginReconciliation('command-delivery', NOW)).toMatchObject({
      state: 'pending',
      attempt: 2,
      commandId: 'command-delivery',
      inputId: 'input-delivery'
    });
    expect(tracker.command('command-delivery')).toEqual(command);
  });
});
