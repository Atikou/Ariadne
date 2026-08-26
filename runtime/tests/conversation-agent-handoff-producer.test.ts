import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationAgentHandoffProducer,
  type ConversationAgentHandoffFixedPointDrainer
} from '../src/composition/ConversationAgentHandoffProducer.js';
import type {
  ConversationAgentHandoffDrainRequest,
  ConversationAgentHandoffDrainResult
} from '../src/composition/ConversationAgentHandoffCoordinator.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';

const FIXED_POINT: ConversationAgentHandoffDrainResult = {
  batches: 0,
  acknowledgedMessages: 0,
  pendingMessages: 0
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConversationAgentHandoffProducer', () => {
  it('stops before start as an idempotent no-op without draining', async () => {
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      const stopping = producer.prepareShutdown(context);

      expect(producer.stop(context)).toBe(stopping);
      await stopping;

      expect(drain).not.toHaveBeenCalled();
      expect(producer.health()).toEqual({ state: 'stopped', failure: null });
      await expect(producer.start()).rejects.toMatchObject({
        code: 'CONVERSATION_AGENT_HANDOFF_PRODUCER_ALREADY_STARTED'
      });
    } finally {
      context.dispose();
    }
  });

  it('surfaces an expired shutdown context without draining before start', async () => {
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    const context = createShutdownContext(Date.now() - 1);
    try {
      const stopping = producer.stop(context);

      await expect(stopping).rejects.toThrow(
        'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
      );
      expect(producer.prepareShutdown(context)).toBe(stopping);
      expect(drain).not.toHaveBeenCalled();
      expect(producer.health()).toEqual({ state: 'stopped', failure: null });
    } finally {
      context.dispose();
    }
  });

  it('does not become ready or start its timer before the startup fixed point', async () => {
    const startup = deferred<ConversationAgentHandoffDrainResult>();
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockReturnValueOnce(startup.promise)
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);

    const starting = producer.start();
    expect(producer.health()).toEqual({ state: 'starting', failure: null });
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(1);

    startup.resolve(FIXED_POINT);
    await starting;
    producer.assertHealthy();
    expect(producer.health()).toEqual({ state: 'running', failure: null });

    await stopProducer(producer);
  });

  it('fails closed when the required startup fixed point fails', async () => {
    const failure = new Error('startup_handoff_failed');
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockRejectedValue(failure);
    const producer = createProducer(drain);

    await expect(producer.start()).rejects.toMatchObject({
      code: 'CONVERSATION_AGENT_HANDOFF_PRODUCER_START_FAILED',
      cause: failure
    });
    expect(producer.health()).toEqual({ state: 'failed', failure });
    expect(() => producer.assertHealthy()).toThrow(
      'Conversation Agent handoff producer is unhealthy.'
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('coalesces timer ticks into one active fixed-point drain', async () => {
    const periodic = deferred<ConversationAgentHandoffDrainResult>();
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    await producer.start();
    drain.mockReturnValueOnce(periodic.promise);

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(drain).toHaveBeenCalledTimes(2);

    periodic.resolve(FIXED_POINT);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(3);

    await stopProducer(producer);
  });

  it('wakes immediately after a durable commit and coalesces repeated wakes', async () => {
    const active = deferred<ConversationAgentHandoffDrainResult>();
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    await producer.start();
    drain.mockReturnValueOnce(active.promise);

    producer.wake();
    producer.wake();
    expect(drain).toHaveBeenCalledTimes(2);

    active.resolve(FIXED_POINT);
    await flushPromises();
    producer.wake();
    expect(drain).toHaveBeenCalledTimes(3);

    await stopProducer(producer);
  });

  it('latches an asynchronous timer failure into observable health', async () => {
    const failure = new Error('periodic_handoff_failed');
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    await producer.start();
    drain.mockRejectedValueOnce(failure);

    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(producer.health()).toEqual({ state: 'failed', failure });
    expect(() => producer.assertHealthy()).toThrowError(expect.objectContaining({
      code: 'CONVERSATION_AGENT_HANDOFF_PRODUCER_NOT_HEALTHY',
      cause: failure
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stops timer admission, joins the active drain, then runs the final fixed point', async () => {
    const active = deferred<ConversationAgentHandoffDrainResult>();
    const final = deferred<ConversationAgentHandoffDrainResult>();
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    await producer.start();
    drain.mockReturnValueOnce(active.promise).mockReturnValueOnce(final.promise);
    await vi.advanceTimersByTimeAsync(10);
    const context = createShutdownContext(Date.now() + 5_000);
    try {
      const preparing = producer.prepareShutdown(context);
      expect(producer.stop(context)).toBe(preparing);
      await vi.advanceTimersByTimeAsync(100);
      expect(drain).toHaveBeenCalledTimes(2);

      active.resolve(FIXED_POINT);
      await flushPromises();
      expect(drain).toHaveBeenCalledTimes(3);
      expect(lastRequest(drain).signal).toBe(context.signal);
      expect(producer.health().state).toBe('stopping');

      final.resolve(FIXED_POINT);
      await preparing;
      expect(producer.health()).toEqual({ state: 'stopped', failure: null });
      await vi.advanceTimersByTimeAsync(100);
      expect(drain).toHaveBeenCalledTimes(3);
    } finally {
      context.dispose();
    }
  });

  it('attempts the final fixed point but still surfaces a prior producer failure', async () => {
    const failure = new Error('background_handoff_failed');
    const drain = vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>()
      .mockResolvedValue(FIXED_POINT);
    const producer = createProducer(drain);
    await producer.start();
    drain.mockRejectedValueOnce(failure);
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    const context = createShutdownContext(Date.now() + 5_000);
    try {
      await expect(producer.prepareShutdown(context)).rejects.toMatchObject({
        code: 'CONVERSATION_AGENT_HANDOFF_PRODUCER_SHUTDOWN_FAILED',
        cause: failure
      });
      expect(drain).toHaveBeenCalledTimes(3);
      expect(lastRequest(drain).signal).toBe(context.signal);
      expect(producer.health()).toEqual({ state: 'stopping', failure });
    } finally {
      context.dispose();
    }
  });
});

function createProducer(
  drainToFixedPoint: ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']
): ConversationAgentHandoffProducer {
  return new ConversationAgentHandoffProducer(
    { drainToFixedPoint },
    {
      drainIntervalMs: 10,
      claimLimit: 7,
      claimLeaseMs: 12_000,
      drainId: 'test-conversation-agent-handoff-producer'
    }
  );
}

async function stopProducer(producer: ConversationAgentHandoffProducer): Promise<void> {
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await producer.stop(context);
  } finally {
    context.dispose();
  }
}

function lastRequest(
  drain: ReturnType<typeof vi.fn<ConversationAgentHandoffFixedPointDrainer['drainToFixedPoint']>>
): ConversationAgentHandoffDrainRequest {
  const call = drain.mock.calls.at(-1);
  if (call === undefined) throw new Error('drain_request_missing');
  return call[0];
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
