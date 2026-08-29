import type { AgentRun } from '@ariadne/agent-core';

export interface AgentRunRetiredToolCatalogTerminalizationReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly checkpointVersion: number;
  readonly status: 'failed';
  readonly reason: 'tool_catalog_retired';
  readonly errorCode: 'agent_tool_catalog_retired';
  readonly replayed: boolean;
}

/** Durable owner for retiring exactly one Run without rebinding its authority. */
export interface AgentRunRetiredToolCatalogTerminalizationOwner {
  terminalize(
    run: AgentRun,
    signal: AbortSignal
  ): Promise<AgentRunRetiredToolCatalogTerminalizationReceipt>;
}
