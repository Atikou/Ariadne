import type { PublicRunDocumentCommit } from '@ariadne/protocol/public';
import type { RuntimePublicEventSink } from '../ingress/RuntimePublicEventSink.js';
import type { RunDocumentPlan } from '../projection/RunDocumentPlan.js';
import type { PublicProjectionRunDocumentCommitSinkV1 } from '../projection/PublicProjectionRunDocumentWritePortsV1.js';
import { PublicProjectionWakePublisher } from './PublicProjectionWakeCommitSink.js';

/** The document extension has the same commit-before-wake boundary. A failed
 * preparation/final commit emits no wake; a failed hint leaves the original
 * durable receipt available to an explicit retry before the caller ACKs. */
export class PublicRunDocumentWakeCommitSink implements PublicProjectionRunDocumentCommitSinkV1 {
  private readonly wakePublisher: PublicProjectionWakePublisher;
  constructor(private readonly projection: PublicProjectionRunDocumentCommitSinkV1, wakeEvents: RuntimePublicEventSink) {
    this.wakePublisher = new PublicProjectionWakePublisher(wakeEvents);
  }
  async appendRunDocument(commit: PublicRunDocumentCommit, plan: RunDocumentPlan): Promise<unknown> {
    const result = await this.projection.appendRunDocument(commit, plan);
    await this.wakePublisher.publish(commit); return result;
  }
}
