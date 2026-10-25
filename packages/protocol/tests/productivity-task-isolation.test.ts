import { describe, expect, it } from 'vitest';
import { runtimeCommandSchema, runtimeResultSchema } from '../src/public.js';

const fault = { faultId: 'fault-a', taskKind: 'workflow', entityId: 'workflow-a', taskId: 'task-a',
  workspaceId: 'workspace-a', ownerSessionId: 'session-a', sessionId: 'task-session-a', revision: 3, state: 'quarantined',
  code: 'task_authority_conflict', occurredAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' };
describe('task fault metadata public boundary', () => {
  it('requires the explicit scoped contract and a finite expected revision', () => {
    const input = { kind: 'productivity.task.reconcile', contractVersion: '1.0', workspaceId: 'workspace-a',
      sessionId: 'session-a', faultId: 'fault-a', expectedRevision: 3 };
    expect(runtimeCommandSchema.parse(input)).toEqual(input);
    for (const expectedRevision of [0, -1, 1.5, Infinity]) expect(runtimeCommandSchema.safeParse({ ...input, expectedRevision }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({ ...input, contractVersion: '5.0' }).success).toBe(false);
  });
  it('rejects protected payloads and bounds fault page size', () => {
    const page = { kind: 'productivity.task_faults.query_result', contractVersion: '1.0', workspaceId: 'workspace-a',
      sessionId: 'session-a', faults: [fault], nextFaultId: null };
    expect(runtimeResultSchema.parse(page)).toEqual(page);
    expect(runtimeResultSchema.safeParse({ ...page, faults: [{ ...fault, prompt: 'private prompt' }] }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({ ...page, faults: Array.from({ length: 129 }, () => fault) }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({ kind: 'productivity.task.reconciled', outcome: 'blind_retry', fault }).success).toBe(false);
  });
});
