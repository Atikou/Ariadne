interface SessionRun {
  sessionId?: string | undefined;
  parentRunId?: string | undefined;
  startedAt?: string | undefined;
  status: string;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export function runStatusTone(status: string): 'success' | 'danger' | 'warning' | 'running' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (['waiting_permission', 'waiting_decision', 'waiting_budget', 'waiting_children', 'cancelling', 'paused', 'interrupted'].includes(status)) return 'warning';
  return status === 'running' ? 'running' : 'neutral';
}

export function selectSessionRun<T extends SessionRun>(runs: readonly T[], sessionId: string | null): T | undefined {
  if (sessionId === null) return undefined;
  const candidates = runs
    .filter(run => run.sessionId === sessionId && run.parentRunId === undefined)
    .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''));
  return candidates.find(run => !terminalStatuses.has(run.status)) ?? candidates[0];
}
