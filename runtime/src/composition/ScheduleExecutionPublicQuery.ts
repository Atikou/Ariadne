import type { AgentRun } from '@ariadne/agent-core';
import type { ProductivityCommand, ProductivityResult } from '@ariadne/protocol/public';
import type { ProductivityAuthority } from '../control/ports/ProductivityAuthority.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ScheduleExecutionFacts } from './ScheduleExecutionFacts.js';

type Page = Extract<ProductivityResult, { kind: 'schedule.occurrences.query_result' }>;
type Query = Extract<ProductivityCommand, { kind: 'schedule.occurrences.query' }>;

/** The explicit occurrence detail query retains its original bounded result summary. */
export class ScheduleExecutionPublicQuery {
  constructor(private readonly store: ProductivityAuthority,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>) {}

  async project(command: Query, page: Page, signal: AbortSignal): Promise<Page> {
    const reader = new ScheduleExecutionFacts(this.store, this.conversation, this.loadRun);
    const occurrences: Page['occurrences'] = [];
    for (const item of page.occurrences) {
      const fact = await reader.read(item.occurrenceId, command.workspaceId, command.sessionId, item.status === 'submitted', signal);
      if (fact === null) { occurrences.push({ ...item, execution: null }); continue; }
      let resultSummary: string | null = null;
      if (fact.resultReference !== null) {
        const result = await this.conversation.readMessageVersion(fact.resultReference.messageId, fact.resultReference.messageVersion);
        if (result === null || result.contentDigest !== fact.resultReference.contentDigest
          || result.sessionId !== command.sessionId || result.workspaceId !== command.workspaceId || result.role !== 'assistant')
          throw new Error('schedule_execution_result_conflict');
        const marker = '【结果已截断，请打开会话查看全文】';
        resultSummary = result.payload.content.length > 4_000
          ? result.payload.content.slice(0, 4_000 - marker.length) + marker : result.payload.content;
      }
      signal.throwIfAborted();
      occurrences.push({ ...item, execution: { status: fact.status, runId: fact.runId,
        resultPending: fact.resultPending, resultSummary } });
    }
    return { ...page, occurrences };
  }
}
