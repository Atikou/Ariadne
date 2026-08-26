import { randomUUID } from 'node:crypto';

import type {
  ConversationAgentHandoffDrainRequest,
  ConversationAgentHandoffDrainResult
} from './ConversationAgentHandoffCoordinator.js';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';

const DEFAULT_DRAIN_INTERVAL_MS = 250;
const DEFAULT_CLAIM_LIMIT = 100;
const DEFAULT_CLAIM_LEASE_MS = 30_000;

export type ConversationAgentHandoffProducerState =
  | 'new'
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface ConversationAgentHandoffFixedPointDrainer {
  drainToFixedPoint(
    request: ConversationAgentHandoffDrainRequest
  ): Promise<ConversationAgentHandoffDrainResult>;
}

export interface ConversationAgentHandoffProducerOptions {
  readonly drainIntervalMs?: number;
  readonly claimLimit?: number;
  readonly claimLeaseMs?: number;
  readonly drainId?: string;
}

export interface ConversationAgentHandoffProducerHealth {
  readonly state: ConversationAgentHandoffProducerState;
  readonly failure: unknown | null;
}

export class ConversationAgentHandoffProducerError extends Error {
  public constructor(
    public readonly code:
      | 'CONVERSATION_AGENT_HANDOFF_PRODUCER_ALREADY_STARTED'
      | 'CONVERSATION_AGENT_HANDOFF_PRODUCER_START_FAILED'
      | 'CONVERSATION_AGENT_HANDOFF_PRODUCER_NOT_HEALTHY'
      | 'CONVERSATION_AGENT_HANDOFF_PRODUCER_SHUTDOWN_FAILED'
      | 'CONVERSATION_AGENT_HANDOFF_PRODUCER_OPTIONS_INVALID',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConversationAgentHandoffProducerError';
  }
}

interface ActiveDrain {
  readonly operation: Promise<ConversationAgentHandoffDrainResult>;
  readonly controller: AbortController | null;
}

/**
 * Owns the complete lifecycle of the Conversation-to-Agent handoff producer.
 * Readiness and shutdown are both exact pending-zero fixed points. Timer ticks
 * only wake the same single-flight drain operation and never own durable state.
 */
export class ConversationAgentHandoffProducer {
  private readonly drainIntervalMs: number;
  private readonly claimLimit: number;
  private readonly claimLeaseMs: number;
  private readonly drainId: string;
  private lifecycle: ConversationAgentHandoffProducerState = 'new';
  private timer: NodeJS.Timeout | null = null;
  private activeDrain: ActiveDrain | null = null;
  private healthFailure: unknown | null = null;
  private startOperation: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;

  public constructor(
    private readonly coordinator: ConversationAgentHandoffFixedPointDrainer,
    options: ConversationAgentHandoffProducerOptions = {}
  ) {
    this.drainIntervalMs = options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.claimLimit = options.claimLimit ?? DEFAULT_CLAIM_LIMIT;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.drainId = options.drainId
      ?? `conversation-agent-handoff-producer:${randomUUID()}`;
    assertOptions(
      this.coordinator,
      this.drainIntervalMs,
      this.claimLimit,
      this.claimLeaseMs,
      this.drainId
    );
  }

  /** The caller must await this exact fixed point before reporting ready. */
  public start(): Promise<void> {
    if (this.startOperation !== null) return this.startOperation;
    if (this.lifecycle !== 'new') {
      return Promise.reject(new ConversationAgentHandoffProducerError(
        'CONVERSATION_AGENT_HANDOFF_PRODUCER_ALREADY_STARTED',
        'Conversation Agent handoff producer cannot be restarted.'
      ));
    }
    this.lifecycle = 'starting';
    this.startOperation = this.finishStart();
    return this.startOperation;
  }

  public assertHealthy(): void {
    if (this.healthFailure !== null) {
      throw new ConversationAgentHandoffProducerError(
        'CONVERSATION_AGENT_HANDOFF_PRODUCER_NOT_HEALTHY',
        'Conversation Agent handoff producer is unhealthy.',
        { cause: this.healthFailure }
      );
    }
    if (this.lifecycle !== 'running') {
      throw new ConversationAgentHandoffProducerError(
        'CONVERSATION_AGENT_HANDOFF_PRODUCER_NOT_HEALTHY',
        'Conversation Agent handoff producer is not running.'
      );
    }
  }

  public health(): ConversationAgentHandoffProducerHealth {
    return Object.freeze({
      state: this.lifecycle,
      failure: this.healthFailure
    });
  }

  /** Wakes the same single-flight producer after a durable outbox commit. */
  public wake(): void {
    if (
      this.lifecycle !== 'running'
      || this.healthFailure !== null
      || this.activeDrain !== null
    ) return;
    const controller = new AbortController();
    void this.beginDrain(controller.signal, controller).catch((error) => {
      this.recordHealthFailure(error);
    });
  }

  /** Stops admission of timer work, joins it, then establishes a final fixed point. */
  public prepareShutdown(context: ShutdownContext): Promise<void> {
    this.stopOperation ??= this.finishStop(context);
    return this.stopOperation;
  }

  public stop(context: ShutdownContext): Promise<void> {
    return this.prepareShutdown(context);
  }

  private async finishStart(): Promise<void> {
    const controller = new AbortController();
    try {
      await this.beginDrain(controller.signal, controller);
      if (this.lifecycle !== 'starting') return;
      this.lifecycle = 'running';
      this.timer = setInterval(() => this.publishOnTimer(), this.drainIntervalMs);
      this.timer.unref?.();
    } catch (error) {
      this.recordHealthFailure(error);
      throw new ConversationAgentHandoffProducerError(
        'CONVERSATION_AGENT_HANDOFF_PRODUCER_START_FAILED',
        'Conversation Agent handoff startup fixed point failed.',
        { cause: error }
      );
    }
  }

  private publishOnTimer(): void {
    this.wake();
  }

  private beginDrain(
    signal: AbortSignal,
    controller: AbortController | null
  ): Promise<ConversationAgentHandoffDrainResult> {
    if (this.activeDrain !== null) return this.activeDrain.operation;
    const operation = this.coordinator.drainToFixedPoint({
      drainId: this.drainId,
      limit: this.claimLimit,
      leaseMs: this.claimLeaseMs,
      signal
    });
    const active: ActiveDrain = { operation, controller };
    this.activeDrain = active;
    void operation.then(
      () => this.clearActiveDrain(active),
      () => this.clearActiveDrain(active)
    );
    return operation;
  }

  private async finishStop(context: ShutdownContext): Promise<void> {
    this.stopTimer();
    if (this.lifecycle === 'new') {
      this.lifecycle = 'stopped';
      context.throwIfExpired(
        'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
      );
      return;
    }
    if (this.lifecycle === 'stopped') {
      context.throwIfExpired();
      return;
    }
    this.lifecycle = 'stopping';
    const failures: unknown[] = [];
    addUniqueFailure(failures, this.healthFailure);

    const active = this.activeDrain;
    if (active !== null) {
      try {
        await joinActiveDrain(active, context);
      } catch (error) {
        addUniqueFailure(failures, error);
      }
    }

    try {
      context.throwIfExpired(
        'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
      );
      await joinWithinShutdown(
        this.beginDrain(context.signal, null),
        context
      );
      context.throwIfExpired(
        'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
      );
    } catch (error) {
      addUniqueFailure(failures, error);
    }

    if (failures.length > 0) {
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'conversation_agent_handoff_producer_failures');
      this.recordHealthFailure(cause);
      throw new ConversationAgentHandoffProducerError(
        'CONVERSATION_AGENT_HANDOFF_PRODUCER_SHUTDOWN_FAILED',
        'Conversation Agent handoff shutdown fixed point failed.',
        { cause }
      );
    }
    this.lifecycle = 'stopped';
  }

  private clearActiveDrain(active: ActiveDrain): void {
    if (this.activeDrain === active) this.activeDrain = null;
  }

  private recordHealthFailure(error: unknown): void {
    this.healthFailure ??= error;
    this.stopTimer();
    if (this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped') {
      this.lifecycle = 'failed';
    }
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

async function joinActiveDrain(
  active: ActiveDrain,
  context: ShutdownContext
): Promise<void> {
  const abort = (): void => {
    if (active.controller !== null && !active.controller.signal.aborted) {
      active.controller.abort(
        context.signal.reason
          ?? new Error('conversation_agent_handoff_producer_shutdown_aborted')
      );
    }
  };
  if (context.signal.aborted) abort();
  else context.signal.addEventListener('abort', abort, { once: true });
  try {
    await joinWithinShutdown(active.operation, context);
  } finally {
    context.signal.removeEventListener('abort', abort);
  }
}

async function joinWithinShutdown<T>(
  operation: Promise<T>,
  context: ShutdownContext
): Promise<T> {
  context.throwIfExpired(
    'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
  );
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error(
      'conversation_agent_handoff_producer_shutdown_deadline_exceeded'
    ));
    onAbort = fail;
    if (context.signal.aborted) fail();
    else context.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
  }
}

function addUniqueFailure(failures: unknown[], failure: unknown | null): void {
  if (failure !== null && !failures.includes(failure)) failures.push(failure);
}

function assertOptions(
  coordinator: ConversationAgentHandoffFixedPointDrainer,
  drainIntervalMs: number,
  claimLimit: number,
  claimLeaseMs: number,
  drainId: string
): void {
  if (
    coordinator === null
    || typeof coordinator !== 'object'
    || typeof coordinator.drainToFixedPoint !== 'function'
    || !Number.isSafeInteger(drainIntervalMs)
    || drainIntervalMs < 1
    || drainIntervalMs > 2_147_483_647
    || !Number.isSafeInteger(claimLimit)
    || claimLimit < 1
    || claimLimit > 100
    || !Number.isSafeInteger(claimLeaseMs)
    || claimLeaseMs < 1
    || claimLeaseMs > 5 * 60 * 1000
    || typeof drainId !== 'string'
    || drainId.length === 0
    || drainId.length > 256
    || drainId.trim() !== drainId
  ) {
    throw new ConversationAgentHandoffProducerError(
      'CONVERSATION_AGENT_HANDOFF_PRODUCER_OPTIONS_INVALID',
      'Conversation Agent handoff producer options are invalid.'
    );
  }
}
