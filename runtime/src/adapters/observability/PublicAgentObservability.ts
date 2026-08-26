import { createHash } from 'node:crypto';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type ProjectionCommitV3,
  type PublicDiagnosticProjectionV3,
  type PublicProjectionSnapshotV3
} from '@ariadne/protocol/public';

import type {
  AgentLifecycleHookDelivery,
  AgentLifecycleHookDeliverySink,
  AgentLifecycleTelemetry
} from '../../control/ports/AgentLifecycleObservability.js';
import type { PublicProjectionCommitSink } from '../../projection/PublicProjectionPorts.js';

const SOURCE_ID = 'agent-observability';
const MAX_DIAGNOSTICS = 512;

export interface PublicAgentObservabilityReader {
  readPublicProjectionSourceCheckpoint(sourceId: string): Promise<number>;
  snapshot(): Promise<PublicProjectionSnapshotV3>;
}

/** Durable, redacted observer adapter with no Agent recovery or execution authority. */
export class PublicAgentObservability implements AgentLifecycleHookDeliverySink {
  private sourceCursor = 0;
  private readonly heads = new Map<string, PublicDiagnosticProjectionV3>();
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly reader: PublicAgentObservabilityReader,
    private readonly sink: PublicProjectionCommitSink,
    private readonly telemetry?: AgentLifecycleTelemetry
  ) {}

  public async start(): Promise<void> {
    const [sourceCursor, snapshot] = await Promise.all([
      this.reader.readPublicProjectionSourceCheckpoint(SOURCE_ID),
      this.reader.snapshot()
    ]);
    this.sourceCursor = sourceCursor;
    for (const diagnostic of snapshot.diagnostics) {
      if (diagnostic.diagnosticId.startsWith('agent-observation:')) {
        this.heads.set(diagnostic.diagnosticId, diagnostic);
      }
    }
  }

  public record(delivery: AgentLifecycleHookDelivery): void {
    const operation = this.tail.then(() => this.append(delivery));
    this.tail = operation.catch(() => undefined);
  }

  public drain(): Promise<void> { return this.tail; }

  private async append(delivery: AgentLifecycleHookDelivery): Promise<void> {
    const diagnosticId = `agent-observation:${hash(delivery.deliveryId)}`;
    if (this.heads.has(diagnosticId)) return;
    this.telemetry?.recordLifecycle({ operation: delivery.event, outcome: delivery.outcome });
    const dto: PublicDiagnosticProjectionV3 = {
      diagnosticId,
      version: 1,
      severity: delivery.outcome === 'rejected' ? 'warning' : 'info',
      code: `AGENT_HOOK_${delivery.event.replaceAll('.', '_')}_${delivery.outcome}`.toUpperCase(),
      message: `Agent lifecycle Hook ${delivery.event} ${delivery.outcome}.`,
      observedAt: delivery.observedAt
    };
    const oldest = this.heads.size >= MAX_DIAGNOSTICS
      ? [...this.heads.values()].sort((left, right) => (
          left.observedAt.localeCompare(right.observedAt)
          || left.diagnosticId.localeCompare(right.diagnosticId)
        ))[0]
      : undefined;
    const sourceCursor = this.sourceCursor + 1;
    const commit: ProjectionCommitV3 = {
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      eventId: `observation-event:${hash(delivery.deliveryId)}`,
      sourceId: SOURCE_ID,
      sourceCursor,
      occurredAt: delivery.observedAt,
      changes: [
        ...(oldest === undefined ? [] : [{
          feature: 'diagnostics' as const, operation: 'delete' as const,
          aggregateId: oldest.diagnosticId, aggregateVersion: oldest.version + 1,
          projectedAt: delivery.observedAt, dto: null
        }]),
        {
          feature: 'diagnostics', operation: 'upsert', aggregateId: diagnosticId,
          aggregateVersion: 1, projectedAt: delivery.observedAt, dto
        }
      ]
    };
    await this.sink.append(commit);
    this.sourceCursor = sourceCursor;
    if (oldest !== undefined) this.heads.delete(oldest.diagnosticId);
    this.heads.set(diagnosticId, dto);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
