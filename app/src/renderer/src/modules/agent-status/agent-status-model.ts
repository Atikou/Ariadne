interface SessionRun {
  sessionId?: string | undefined;
  parentRunId?: string | undefined;
  startedAt?: string | undefined;
  status: string;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export function selectSessionRun<T extends SessionRun>(runs: readonly T[], sessionId: string | null): T | undefined {
  if (sessionId === null) return undefined;
  const candidates = runs
    .filter(run => run.sessionId === sessionId && run.parentRunId === undefined)
    .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''));
  return candidates.find(run => !terminalStatuses.has(run.status)) ?? candidates[0];
}
