import {
  runtimeEventEnvelopeSchema,
  runtimeEventSchema,
  type RuntimeEventEnvelope,
} from "@ariadne/protocol/public";

import type { RunAggregate } from "../run/RunAggregateRepository.js";
import { projectRun } from "../application/publicProjection.js";
import type {
  DomainEventJournal,
  PersistedDomainEvent,
} from "./DomainEventJournal.js";

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_PAGE_SIZE = 500;

export type RuntimeEventEnvelopeSink = (event: RuntimeEventEnvelope) => void;

export class RuntimeEventDispatcher {
  private cursor = 0;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private flushRequested = false;
  private running = false;

  constructor(
    private readonly journal: DomainEventJournal,
    private readonly sink: RuntimeEventEnvelopeSink,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cursor = this.journal.currentCursor();
    this.timer = setInterval(() => {
      void this.flush();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushing;
  }

  flush(): Promise<void> {
    this.flushRequested = true;
    if (!this.flushing) {
      this.flushing = this.flushUntilSettled()
        .finally(() => {
          this.flushing = undefined;
        });
    }
    return this.flushing;
  }

  replay(afterCursor: number, limit: number): RuntimeEventEnvelope[] {
    return this.journal
      .replay({ afterCursor, limit })
      .map((event) => projectEnvelope(event));
  }

  currentCursor(): number {
    return this.journal.currentCursor();
  }

  private async flushUntilSettled(): Promise<void> {
    do {
      this.flushRequested = false;
      await this.flushPages();
    } while (this.flushRequested);
  }

  private async flushPages(): Promise<void> {
    while (true) {
      const page = this.replay(this.cursor, DEFAULT_PAGE_SIZE);
      if (page.length === 0) return;
      for (const envelope of page) {
        this.sink(envelope);
        this.cursor = envelope.cursor;
      }
      if (page.length < DEFAULT_PAGE_SIZE) return;
      await Promise.resolve();
    }
  }
}

function projectEnvelope(persisted: PersistedDomainEvent): RuntimeEventEnvelope {
  const event = persisted.aggregateType === "run"
    ? projectRunDomainEvent(persisted.event)
    : runtimeEventSchema.parse(persisted.event);
  return runtimeEventEnvelopeSchema.parse({
    eventId: persisted.eventId,
    cursor: persisted.cursor,
    schemaVersion: persisted.schemaVersion,
    aggregateType: persisted.aggregateType,
    aggregateId: persisted.aggregateId,
    aggregateVersion: persisted.aggregateVersion,
    correlationId: persisted.correlationId,
    causationId: persisted.causationId,
    occurredAt: persisted.occurredAt,
    event,
  });
}

function projectRunDomainEvent(value: unknown) {
  const payload = value as { run?: RunAggregate };
  if (!payload.run) throw new Error("run_domain_event_missing_aggregate");
  return {
    kind: "run.changed" as const,
    run: projectRun(payload.run),
  };
}
