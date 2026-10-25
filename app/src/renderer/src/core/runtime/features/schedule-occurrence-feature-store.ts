import { PUBLIC_PROJECTION_CONTRACT_VERSION, type RuntimeResult } from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type ScheduleOccurrencePage = Extract<RuntimeResult, { kind: 'schedule.occurrences.query_result' }>;

/** Submission history has its own paging and optimistic retry commands. */
export class ScheduleOccurrenceFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}

  async query(workspaceId: string, sessionId: string, before: ScheduleOccurrencePage['nextCursor'] = null): Promise<ScheduleOccurrencePage> {
    const result = await this.gateway.execute({
      kind: 'schedule.occurrences.query', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId, sessionId, before, limit: 50
    });
    if (result.kind !== 'schedule.occurrences.query_result') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result;
  }

  async retry(input: {
    workspaceId: string; sessionId: string; occurrenceId: string; expectedAttempts: number;
  }): Promise<ScheduleOccurrencePage['occurrences'][number]> {
    const result = await this.gateway.execute({
      kind: 'schedule.occurrence.retry', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, ...input
    });
    if (result.kind !== 'schedule.occurrence.updated') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.occurrence;
  }
}
