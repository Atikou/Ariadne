import { AgentRunTransitionError, AgentRunVersionConflictError, type AgentRun } from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { SqliteAgentRunUnitOfWork } from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { AgentRequiredChildCancellationWorker } from '../src/composition/agent-entity/components/run-control/AgentRequiredChildCancellationWorker.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { AgentInferenceCancellationConflictError } from '../src/control/ports/AgentInferenceCancellationConflict.js';
import { publicRunMutationFailure } from '../src/composition/AgentPublicCommandFailures.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';

const parent = { runId: 'parent', version: 4, createdAt: '2030-01-01T00:00:00.000Z',
  state: { status: 'cancelling', requestedAt: '2030-01-01T00:00:04.000Z', requiredChildRunIds: ['child'], terminalChildRunIds: [] } };
const leaf = () => ({ runId: 'child', version: 2, state: { status: 'running' }, updatedAt: '2030-01-01T00:00:02.000Z', effects: [], turns: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function unit(query: () => Promise<unknown>, loadRun: () => unknown): SqliteAgentRunUnitOfWork {
  return { listActiveRuns: query, transaction: async (operation: (transaction: unknown) => unknown) =>
    operation({ loadRun: async () => loadRun() }) } as unknown as SqliteAgentRunUnitOfWork;
}
async function stop(worker: AgentRequiredChildCancellationWorker) {
  const context = createShutdownContext(Date.now() + 2_000);
  try { await worker.stop(context); } finally { context.dispose(); }
}

describe('required child cancellation worker ownership', () => {
  it('reports a cancellation-owner conflict as a sanitized retryable public outcome', () => {
    const envelope = { correlationId: 'public-cancel-correlation' } as RuntimeCommandEnvelope;
    const failure = publicRunMutationFailure(envelope, new AgentInferenceCancellationConflictError('private-run-identity', 'interruption'));
    expect(failure).toMatchObject({ settlement: 'completed', outcome: { ok: false, error: {
      code: 'agent_run_cancellation_in_progress', retryable: true, correlationId: envelope.correlationId
    } } });
    expect(JSON.stringify(failure)).not.toContain('private-run-identity');
    expect(JSON.stringify(failure)).not.toContain('AGENT_INFERENCE_CANCELLATION_CONFLICT');
  });
  it('single-flights startup and joins a pending scan without claiming a child after stop', async () => {
    const scan = deferred<unknown>();
    const query = vi.fn(() => scan.promise);
    const cancel = vi.fn(async () => ({ status: 'cancelled' as const, runId: 'child', runVersion: 3 }));
    const worker = new AgentRequiredChildCancellationWorker(unit(query, leaf), cancel);
    const starting = worker.start(() => undefined);
    expect(worker.start(() => undefined)).toBe(starting);
    const shutdown = createShutdownContext(Date.now() + 2_000);
    try {
      const stopping = worker.stop(shutdown);
      expect(worker.stop(shutdown)).toBe(stopping);
      scan.resolve({ items: [{ run: parent }] });
      await starting;
      await stopping;
      worker.wake();
      expect(query).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      expect(() => worker.assertHealthy()).toThrow(/not_running/u);
      await expect(worker.start(() => undefined)).rejects.toThrow(/cannot_restart/u);
    } finally { shutdown.dispose(); }
  });

  it('joins the cancellation owner during shutdown and permits only one overlapping scan', async () => {
    let includeParent = false;
    const completion = deferred<void>();
    const query = vi.fn(async () => ({ items: includeParent ? [{ run: parent }] : [] }));
    const cancel = vi.fn(async () => { await completion.promise; return { status: 'cancelled' as const, runId: 'child', runVersion: 3 }; });
    const worker = new AgentRequiredChildCancellationWorker(unit(query, leaf), cancel);
    await worker.start(() => undefined);
    includeParent = true;
    worker.wake();
    worker.wake();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    const closing = stop(worker);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    completion.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  it.each(['uncertain_effect', 'started_effect', 'started_inference'] as const)(
    'preserves %s for its result or recovery owner without reporting false cancellation', async kind => {
      const child = { ...leaf(), effects: kind === 'started_inference' ? [] : [{ state: { status: kind === 'uncertain_effect' ? 'uncertain' : 'started' } }],
        turns: kind === 'started_inference' ? [{ attempts: [{ state: { status: 'started' } }] }] : [] };
      const cancel = vi.fn(async () => { throw new AgentRunTransitionError('External execution has not settled.'); });
      const worker = new AgentRequiredChildCancellationWorker(unit(async () => ({ items: [{ run: parent }] }), () => child), cancel);
      try {
        await worker.start(() => undefined);
        worker.assertHealthy();
        expect(cancel).toHaveBeenCalledTimes(kind === 'uncertain_effect' ? 0 : 1);
        expect(child.state.status).toBe('running');
      } finally { await stop(worker); }
    }
  );

  it.each(['version_conflict', 'cancellation_owned'] as const)('rescans %s instead of faulting the durable cancellation queue', async conflict => {
    let child = leaf();
    const cancel = vi.fn(async (_id, command) => {
      if (command.expectedVersion === 2) {
        child = { ...child, version: 3 };
        throw conflict === 'version_conflict' ? new AgentRunVersionConflictError('child', 2, 3)
          : new AgentInferenceCancellationConflictError('child', 'interruption');
      }
      return { status: 'cancelled' as const, runId: 'child', runVersion: 4 };
    });
    const worker = new AgentRequiredChildCancellationWorker(unit(async () => ({ items: [{ run: parent }] }), () => child), cancel);
    try {
      await worker.start(() => undefined);
      await worker.drainOnce();
      worker.assertHealthy();
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.calls[0]![0]).not.toBe(cancel.mock.calls[1]![0]);
      expect(cancel.mock.calls[1]![1].expectedVersion).toBe(3);
    } finally { await stop(worker); }
  });

  it('fails a repeated paging cursor closed instead of spinning indefinitely', async () => {
    let count = 0;
    const query = vi.fn(async () => ({ items: [{ run: { runId: `run-${count++}`, state: { status: 'running' } } as AgentRun }],
      nextCursor: { createdAt: parent.createdAt, runId: 'cursor-run' } }));
    const cancel = vi.fn(async () => ({ status: 'cancelled' as const, runId: 'child', runVersion: 3 }));
    const worker = new AgentRequiredChildCancellationWorker(unit(query, leaf), cancel);
    await expect(worker.start(() => undefined)).rejects.toThrow(/cursor_repeated/u);
    expect(() => worker.assertHealthy()).toThrow(/cursor_repeated/u);
    expect(query).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    await stop(worker);
  });
});
