import { describe, expect, it } from 'vitest';
import { runtimeCommandSchema, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { ProductivityTaskFaultFeatureStore, type ProductivityTaskFault } from '../src/renderer/src/core/runtime/features/productivity-task-fault-feature-store';

const fault: ProductivityTaskFault = { faultId: 'fault-a', taskKind: 'workflow', entityId: 'workflow-a', taskId: 'task-a',
  workspaceId: 'workspace-a', ownerSessionId: 'session-a', sessionId: 'task-session-a', revision: 3, state: 'quarantined',
  code: 'task_authority_conflict', occurredAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' };
describe('scoped task recovery command identities', () => {
  it('looks up the persisted original command after reloading an in-progress claim instead of inventing a new recovery intent', async () => {
    const calls: { command: RuntimeCommand; commandId: string | undefined }[] = [];
    const gateway = { execute: async (command: RuntimeCommand, commandId?: string): Promise<RuntimeResult> => {
      calls.push({ command, commandId });
      if (command.kind === 'productivity.task_recovery.claims.query') return { kind: 'productivity.task_recovery.claims_result',
        contractVersion: '1.0', workspaceId: fault.workspaceId, sessionId: fault.ownerSessionId,
        references: [{ faultId: fault.faultId, claimRevision: 4, expectedRevision: 3, commandId: 'original-custom-owner-command' }] };
      return { kind: 'productivity.task.reconciled', outcome: 'unresolved', fault: { ...fault, revision: 5 } };
    } };
    await new ProductivityTaskFaultFeatureStore(gateway).reconcile({ ...fault, state: 'reconciling', revision: 4 });
    expect(calls[1]!.commandId).toBe('original-custom-owner-command');
    expect(calls[1]!.command).toMatchObject({ kind: 'productivity.task.reconcile', expectedRevision: 3 });
    expect(calls).toHaveLength(2);
  });
  it('reuses the same identity after a new feature instance, while a refreshed revision creates another intent', async () => {
    const calls: { command: RuntimeCommand; commandId: string | undefined }[] = [];
    const gateway = { execute: async (input: RuntimeCommand, commandId?: string): Promise<RuntimeResult> => {
      const command = runtimeCommandSchema.parse(input); calls.push({ command, commandId });
      if (command.kind !== 'productivity.task.reconcile') throw new Error('unexpected_command');
      return { kind: 'productivity.task.reconciled', outcome: 'unresolved',
        fault: { ...fault, revision: command.expectedRevision + 2 } };
    } };
    await new ProductivityTaskFaultFeatureStore(gateway).reconcile(fault);
    await new ProductivityTaskFaultFeatureStore(gateway).reconcile(fault);
    await new ProductivityTaskFaultFeatureStore(gateway).reconcile({ ...fault, revision: 5 });
    expect(calls[0]!.commandId).toBe(calls[1]!.commandId);
    expect(calls[0]!.commandId).not.toBe(calls[2]!.commandId);
    expect(calls[0]!.command).toEqual({ kind: 'productivity.task.reconcile', contractVersion: '1.0',
      workspaceId: 'workspace-a', sessionId: 'session-a', faultId: 'fault-a', expectedRevision: 3 });
    expect(JSON.stringify(calls)).not.toContain('task-session-a');
  });
  it.each(['foreign_scope', 'unordered', 'wrong_cursor'] as const)('rejects %s query pages rather than displaying another owner or assembling a false page', async mode => {
    const result: Extract<RuntimeResult, { kind: 'productivity.task_faults.query_result' }> = {
      kind: 'productivity.task_faults.query_result', contractVersion: '1.0', workspaceId: fault.workspaceId,
      sessionId: fault.ownerSessionId, faults: [fault], nextFaultId: null };
    if (mode === 'foreign_scope') result.faults = [{ ...fault, ownerSessionId: 'foreign-owner' }];
    if (mode === 'unordered') result.faults = [fault, fault];
    if (mode === 'wrong_cursor') result.nextFaultId = 'foreign-cursor';
    const feature = new ProductivityTaskFaultFeatureStore({ execute: async () => result });
    await expect(feature.query(fault.workspaceId, fault.ownerSessionId)).rejects.toThrow('不匹配');
  });
  it('rejects a recovery result from a foreign parent scope', async () => {
    const feature = new ProductivityTaskFaultFeatureStore({ execute: async () => ({ kind: 'productivity.task.reconciled',
      outcome: 'unresolved', fault: { ...fault, ownerSessionId: 'foreign-owner', revision: 5 } }) });
    await expect(feature.reconcile(fault)).rejects.toThrow('不匹配');
  });
});
