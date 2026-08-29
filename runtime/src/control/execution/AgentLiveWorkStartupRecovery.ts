import type {
  AgentJsonValue,
  AgentRunRecoveryPayloadReader,
  AgentRunRecoveryQuery
} from '@ariadne/agent-core';

import type { AgentLiveWorkCompletionNotification } from '../ports/AgentLiveWork.js';

const RECOVERY_PAGE_SIZE = 100;

export interface AgentLiveWorkStartupRecoverySink {
  notify(notification: AgentLiveWorkCompletionNotification): Promise<void>;
}

type AgentLiveWorkStartupRecoveryStore = AgentRunRecoveryQuery
  & Pick<AgentRunRecoveryPayloadReader, 'loadEffectResult'>;

/** Rebuilds crash-interruption facts from protected live-work start Effect results. */
export class AgentLiveWorkStartupRecovery {
  public constructor(
    private readonly store: AgentLiveWorkStartupRecoveryStore,
    private readonly sink: AgentLiveWorkStartupRecoverySink,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async reconcile(): Promise<void> {
    let after: { readonly createdAt: string; readonly runId: string } | undefined;
    const visitedCursors = new Set<string>();
    do {
      const page = await this.store.listActiveRuns({
        limit: RECOVERY_PAGE_SIZE,
        ...(after === undefined ? {} : { after })
      });
      for (const recovery of page.items) {
        if (!recovery.ready || recovery.phase !== 'resumable') continue;
        const recordedJobIds = new Set(
          recovery.run.inbox.flatMap((input) => (
            input.source?.kind === 'live_work' ? [input.source.jobId] : []
          ))
        );
        const resultReferences = new Map(
          recovery.effectPayloads
            .filter((reference) => reference.hasResult)
            .map((reference) => [reference.effectId, reference] as const)
        );
        for (const effect of recovery.run.effects) {
          const expectedKind = startedWorkKind(effect.tool.toolName);
          if (
            expectedKind === undefined
            || effect.state.status !== 'succeeded'
          ) continue;
          const reference = resultReferences.get(effect.effectId);
          if (reference === undefined) {
            throw new Error('agent_live_work_startup_effect_result_missing');
          }
          const started = parseRunningLiveWorkResult(
            await this.store.loadEffectResult(reference),
            expectedKind
          );
          if (recordedJobIds.has(started.jobId)) continue;
          await this.sink.notify({
            runId: recovery.run.runId,
            workspaceId: recovery.run.binding.workspace.workspaceId,
            jobId: started.jobId,
            workKind: expectedKind,
            status: 'interrupted',
            finishedAt: this.now().toISOString(),
            outputCursor: started.outputCursor,
            detail: 'runtime_restarted_before_live_work_completion'
          });
          recordedJobIds.add(started.jobId);
        }
      }
      after = page.nextCursor;
      if (after !== undefined) {
        const cursorKey = `${after.createdAt}\u0000${after.runId}`;
        if (visitedCursors.has(cursorKey)) {
          throw new Error('agent_live_work_startup_recovery_cursor_repeated');
        }
        visitedCursors.add(cursorKey);
      }
    } while (after !== undefined);
  }
}

interface RunningLiveWorkResult {
  readonly jobId: string;
  readonly outputCursor: number;
}

function parseRunningLiveWorkResult(
  value: AgentJsonValue,
  expectedKind: 'process' | 'terminal'
): RunningLiveWorkResult {
  if (!isRecord(value)) throw invalidResult();
  const { jobId, kind, status, outputCursor } = value;
  if (
    typeof jobId !== 'string'
    || jobId.length === 0
    || kind !== expectedKind
    || status !== 'running'
    || typeof outputCursor !== 'number'
    || !Number.isSafeInteger(outputCursor)
    || outputCursor < 0
  ) throw invalidResult();
  return { jobId, outputCursor };
}

function isRecord(value: AgentJsonValue): value is Readonly<Record<string, AgentJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResult(): Error {
  return new Error('agent_live_work_startup_result_invalid');
}

function startedWorkKind(toolName: string): 'process' | 'terminal' | undefined {
  if (toolName === 'workspace.process_start') return 'process';
  if (toolName === 'workspace.terminal_start') return 'terminal';
  return undefined;
}
