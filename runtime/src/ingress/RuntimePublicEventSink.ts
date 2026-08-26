import type { RuntimeEvent, RuntimeEventEnvelope } from '@ariadne/protocol/public';

/**
 * Durable public-event append accepted by the Runtime application boundary.
 *
 * Producers own the stable aggregate identity. Runtime owns cursor assignment,
 * exact-replay validation, persistence, and delivery to the public event sink.
 */
export interface RuntimePublicEventAppend {
  readonly eventId: string;
  readonly aggregateType: RuntimeEventEnvelope['aggregateType'];
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly event: RuntimeEvent;
}

export interface RuntimePublicEventSink {
  append(event: RuntimePublicEventAppend): Promise<void>;
}
