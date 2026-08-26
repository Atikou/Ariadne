import type {
  RuntimePublicEventAppend,
  RuntimePublicEventSink
} from '../ingress/RuntimePublicEventSink.js';
import type { DomainEventJournal } from './DomainEventJournal.js';

/**
 * The single structured write boundary into Runtime's public event journal.
 * Delivery notification is awaited so an external producer acknowledges its
 * own outbox only after Runtime has accepted and flushed the durable event.
 */
export class DomainEventJournalPublicEventSink
implements RuntimePublicEventSink {
  public constructor(
    private readonly journal: DomainEventJournal,
    private readonly flush: () => Promise<void>
  ) {}

  public async append(event: RuntimePublicEventAppend): Promise<void> {
    this.journal.append(event);
    await this.flush();
  }
}
