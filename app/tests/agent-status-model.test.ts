import { describe, expect, it } from 'vitest';
import { selectSessionRun } from '../src/renderer/src/modules/agent-status/agent-status-model';

describe('current session task selection', () => {
  const runs = [
    { id: 'old', sessionId: 'a', status: 'completed', startedAt: '2026-09-01T00:00:00Z' },
    { id: 'other', sessionId: 'b', status: 'running', startedAt: '2026-09-05T00:00:00Z' },
    { id: 'current', sessionId: 'a', status: 'waiting_decision', startedAt: '2026-09-04T00:00:00Z' },
    { id: 'child', sessionId: 'a', parentRunId: 'current', status: 'running', startedAt: '2026-09-05T00:00:00Z' }
  ];
  it('does not show another session or a child as the current task', () => {
    expect(selectSessionRun(runs, 'a')?.id).toBe('current');
    expect(selectSessionRun(runs, 'b')?.id).toBe('other');
    expect(selectSessionRun(runs, 'missing')).toBeUndefined();
    expect(selectSessionRun(runs, null)).toBeUndefined();
  });
  it('selects the newest historical root when no task is active without mutating the store', () => {
    const history = [runs[0]!, { id: 'recent', sessionId: 'a', status: 'completed', startedAt: '2026-09-03T00:00:00Z' }];
    expect(selectSessionRun(history, 'a')?.id).toBe('recent');
    expect(history[0]?.id).toBe('old');
  });
});
