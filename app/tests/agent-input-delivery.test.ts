import { describe, expect, it } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import {
  AgentInputDeliveryTracker
} from '../src/renderer/src/core/runtime/agent-input-delivery';
import { NOW, run } from './projection-v3-fixture';

describe('Agent input delivery presentation state', () => {
  it('defers to the authoritative inbox projection and settles as accepted', () => {
    const tracker = new AgentInputDeliveryTracker();
    const command = {
      kind: 'agent.inbox.enqueue.v3' as const,
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-delivery',
      sessionId: 'session-a',
      inputId: 'input-delivery',
      delivery: 'next_step' as const,
      content: 'Continue after the current effect.'
    };
    tracker.begin('command-delivery', command, NOW);
    tracker.requireReconciliation('command-delivery', 'Outcome unknown.', NOW);

    const projectedRun = run('run-delivery', 'running', 5);
    expect(tracker.observeProjection([{
      ...projectedRun,
      inbox: [{
        inputId: command.inputId,
        messageId: 'message-delivery',
        version: 1,
        delivery: command.delivery,
        content: command.content,
        state: 'queued',
        queuedAt: NOW,
        updatedAt: NOW
      }]
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
      kind: 'agent.inbox.enqueue.v3' as const,
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
      kind: 'agent.inbox.enqueue.v3' as const,
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
