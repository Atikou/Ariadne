import { productivityTaskRecoveryResultSchema, type RuntimeResult } from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';

export type ProductivityTaskFaultPage = Extract<RuntimeResult, { kind: 'productivity.task_faults.query_result' }>;
export type ProductivityTaskFault = ProductivityTaskFaultPage['faults'][number];
export class ProductivityTaskFaultFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}
  async query(workspaceId: string, sessionId: string, afterFaultId?: string): Promise<ProductivityTaskFaultPage> {
    const result = await this.gateway.execute({ kind: 'productivity.task_faults.query', contractVersion: '1.0',
      workspaceId, sessionId, limit: 32, ...(afterFaultId === undefined ? {} : { afterFaultId }) });
    if (result.kind !== 'productivity.task_faults.query_result' || result.workspaceId !== workspaceId || result.sessionId !== sessionId
      || result.faults.some(fault => fault.workspaceId !== workspaceId || fault.ownerSessionId !== sessionId)
      || result.faults.some((fault, index, faults) => (index > 0 && fault.faultId <= faults[index - 1]!.faultId)
        || (afterFaultId !== undefined && fault.faultId <= afterFaultId))
      || (result.nextFaultId !== null && result.nextFaultId !== result.faults.at(-1)?.faultId))
      throw new Error('任务隔离记录与当前会话不匹配，请重新读取。');
    return result;
  }
  async reconcile(fault: ProductivityTaskFault) {
    let original: { expectedRevision: number; commandId: string } | undefined;
    if (fault.state === 'reconciling') {
      const recovery = await this.gateway.execute({ kind: 'productivity.task_recovery.claims.query', contractVersion: '1.0',
        workspaceId: fault.workspaceId, sessionId: fault.ownerSessionId, claims: [{ faultId: fault.faultId, revision: fault.revision }] });
      if (recovery.kind !== 'productivity.task_recovery.claims_result' || recovery.workspaceId !== fault.workspaceId
        || recovery.sessionId !== fault.ownerSessionId || recovery.references.length !== 1
        || recovery.references[0]!.faultId !== fault.faultId || recovery.references[0]!.claimRevision !== fault.revision
        || recovery.references[0]!.expectedRevision !== fault.revision - 1)
        throw new Error('原恢复命令身份未就绪，请刷新任务状态后核对。');
      original = recovery.references[0]!;
    }
    const command = { kind: 'productivity.task.reconcile', contractVersion: '1.0', workspaceId: fault.workspaceId,
      sessionId: fault.ownerSessionId, faultId: fault.faultId, expectedRevision: original?.expectedRevision ?? fault.revision } as const;
    // The same scoped revision denotes the same reconciliation intent, even
    // after Renderer reload. A refreshed revision creates a new intent.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(command)));
    const commandId = original?.commandId ?? `task-recovery-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const result = productivityTaskRecoveryResultSchema.parse(await this.gateway.execute(command, commandId));
    if (result.fault.faultId !== fault.faultId || result.fault.workspaceId !== fault.workspaceId
      || result.fault.ownerSessionId !== fault.ownerSessionId || result.fault.revision <= fault.revision)
      throw new Error('恢复回执与当前任务不匹配，请重新读取。');
    return result;
  }
}
