import type {
  RuntimePublicEventAppend,
  RuntimePublicEventSink
} from '../ingress/RuntimePublicEventSink.js';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';

const MAX_RETRY_DELAY_MS = 2_000;

/**
 * Lifecycle gate and retry queue for non-authoritative Projection wake hints.
 *
 * Projection commits remain the only truth. During bootstrap, hints are
 * coalesced until Runtime's durable event dispatcher has started. Delivery
 * failures retry the exact event independently and never poison Projection
 * reads or Agent Control health.
 */
export class DeferredProjectionWakeEventSink
implements RuntimePublicEventSink {
  private target?: RuntimePublicEventSink;
  private enabled = false;
  private closed = false;
  private readonly queued = new Map<string, RuntimePublicEventAppend>();
  private retryEvent: RuntimePublicEventAppend | null = null;
  private activeDrain: Promise<void> | null = null;
  private retryTimer?: NodeJS.Timeout;
  private failedAttempts = 0;

  public bind(target: RuntimePublicEventSink): void {
    if (this.target !== undefined) throw new Error('projection_wake_sink_already_bound');
    if (this.closed) throw new Error('projection_wake_sink_closed');
    this.target = target;
  }

  public enable(): void {
    if (this.closed) return;
    if (this.target === undefined) throw new Error('projection_wake_sink_not_bound');
    this.enabled = true;
    this.requestDrain();
  }

  public append(event: RuntimePublicEventAppend): Promise<void> {
    assertProjectionWake(event);
    if (this.closed) return Promise.resolve();
    const key = aggregateKey(event);
    const retry = this.retryEvent;
    if (retry !== null && aggregateKey(retry) === key) {
      if (event.aggregateVersion < retry.aggregateVersion) return Promise.resolve();
      if (event.aggregateVersion === retry.aggregateVersion) {
        if (!sameEvent(event, retry)) throw new Error('projection_wake_identity_drift');
        return Promise.resolve();
      }
    }
    const current = this.queued.get(key);
    if (current === undefined || event.aggregateVersion > current.aggregateVersion) {
      this.queued.set(key, freezeEvent(event));
    } else if (
      event.aggregateVersion === current.aggregateVersion
      && !sameEvent(event, current)
    ) {
      throw new Error('projection_wake_identity_drift');
    }
    if (this.enabled) this.requestDrain();
    return Promise.resolve();
  }

  public async close(context: ShutdownContext): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.queued.clear();
    this.retryEvent = null;
    const active = this.activeDrain;
    if (active === null) return;
    context.throwIfExpired('projection_wake_shutdown_deadline_exceeded');
    await waitForDrain(active, context);
  }

  /** Test/diagnostic state only; never used as a public health authority. */
  public status(): {
    readonly enabled: boolean;
    readonly pending: number;
    readonly failedAttempts: number;
  } {
    return {
      enabled: this.enabled,
      pending: this.queued.size + (this.retryEvent === null ? 0 : 1),
      failedAttempts: this.failedAttempts
    };
  }

  private requestDrain(): void {
    if (
      !this.enabled
      || this.closed
      || this.activeDrain !== null
      || this.retryTimer !== undefined
      || (this.retryEvent === null && this.queued.size === 0)
    ) return;
    const operation = this.drainOne().finally(() => {
      if (this.activeDrain === operation) this.activeDrain = null;
      if (!this.closed && this.enabled) this.requestDrain();
    });
    this.activeDrain = operation;
  }

  private async drainOne(): Promise<void> {
    const target = this.target;
    if (target === undefined) return;
    const event = this.retryEvent ?? takeFirst(this.queued);
    if (event === null) return;
    try {
      await target.append(event);
      if (this.retryEvent === event) this.retryEvent = null;
      this.failedAttempts = 0;
    } catch {
      this.retryEvent = event;
      this.failedAttempts += 1;
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed || !this.enabled || this.retryTimer !== undefined) return;
    const exponent = Math.min(6, Math.max(0, this.failedAttempts - 1));
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, 50 * (2 ** exponent));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestDrain();
    }, delayMs);
    this.retryTimer.unref?.();
  }
}

function assertProjectionWake(event: RuntimePublicEventAppend): void {
  if (
    event.aggregateType !== 'projection'
    || event.event.kind !== 'projection.changed'
    || event.aggregateId.trim().length === 0
    || !Number.isSafeInteger(event.aggregateVersion)
    || event.aggregateVersion < 1
  ) {
    throw new Error('projection_wake_event_invalid');
  }
}

function aggregateKey(event: RuntimePublicEventAppend): string {
  return `${event.aggregateType}\u0000${event.aggregateId}`;
}

function freezeEvent(event: RuntimePublicEventAppend): RuntimePublicEventAppend {
  return Object.freeze({
    ...event,
    event: Object.freeze({ ...event.event })
  });
}

function sameEvent(
  left: RuntimePublicEventAppend,
  right: RuntimePublicEventAppend
): boolean {
  return left.eventId === right.eventId
    && left.aggregateType === right.aggregateType
    && left.aggregateId === right.aggregateId
    && left.aggregateVersion === right.aggregateVersion
    && left.correlationId === right.correlationId
    && left.causationId === right.causationId
    && left.occurredAt === right.occurredAt
    && left.event.kind === 'projection.changed'
    && right.event.kind === 'projection.changed'
    && left.event.feature === right.event.feature;
}

function takeFirst(
  queue: Map<string, RuntimePublicEventAppend>
): RuntimePublicEventAppend | null {
  const first = queue.entries().next();
  if (first.done) return null;
  const [key, event] = first.value;
  queue.delete(key);
  return event;
}

async function waitForDrain(
  active: Promise<void>,
  context: ShutdownContext
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    await Promise.race([
      active,
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new Error('projection_wake_shutdown_deadline_exceeded'));
        if (context.signal.aborted) {
          fail();
          return;
        }
        context.signal.addEventListener('abort', fail, { once: true });
        removeAbort = () => context.signal.removeEventListener('abort', fail);
        timer = setTimeout(fail, context.remainingMs());
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort?.();
  }
}
