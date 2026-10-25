// Explicit UI fixture: production component/feature store, deferred gateway,
// no Runtime, Provider, credentials, execution or user data.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { runtimeCommandSchema, type RuntimeCommand, type RuntimeResult } from '@ariadne/protocol/public';
import { ProductivityTaskFaultFeatureStore, type ProductivityTaskFault } from '../src/renderer/src/core/runtime/features/productivity-task-fault-feature-store';
import { ProductivityTaskFaults } from '../src/renderer/src/modules/productivity/ProductivityTaskFaults';
import '../src/renderer/src/app/styles.css';

type Deferred = { command: RuntimeCommand; commandId?: string; resolve(value: RuntimeResult): void; reject(error: Error): void };
const queries: Deferred[] = [], recoveries: Deferred[] = [], selected: string[] = [], unhandled: string[] = [];
window.addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
const source = (sessionId: string): ProductivityTaskFault => ({ faultId: `fixture-fault-${sessionId}`, taskKind: 'workflow',
  entityId: `fixture-workflow-${sessionId}`, taskId: `fixture-task-${sessionId}-${'long'.repeat(24)}`, workspaceId: 'fixture-workspace',
  ownerSessionId: sessionId, sessionId: `fixture-child-${sessionId}`, revision: 1, state: 'quarantined', code: 'task_authority_conflict',
  occurredAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' });
const faults = new ProductivityTaskFaultFeatureStore({ execute: (input, commandId) => new Promise((resolve, reject) => {
  const command = runtimeCommandSchema.parse(input);
  (command.kind === 'productivity.task_faults.query' ? queries : recoveries).push({ command,
    ...(commandId === undefined ? {} : { commandId }), resolve, reject });
}) });
let select: (sessionId: string) => void = () => {};
Object.assign(window, { __taskIsolationFixture: { queries, recoveries, selected, unhandled, select: (id: string) => select(id),
  resolveQuery: (index: number, resolved = false) => {
    const query = queries[index]!, command = query.command;
    if (command.kind !== 'productivity.task_faults.query') throw new Error('fixture_query_kind');
    query.resolve({ kind: 'productivity.task_faults.query_result', contractVersion: '1.0', workspaceId: command.workspaceId,
      sessionId: command.sessionId, faults: [{ ...source(command.sessionId), ...(resolved ? { state: 'resolved', revision: 3 } : {}) }], nextFaultId: null });
  },
  resolveRecovery: (index: number, fail = false) => {
    const recovery = recoveries[index]!, command = recovery.command;
    if (command.kind !== 'productivity.task.reconcile') throw new Error('fixture_recovery_kind');
    if (fail) recovery.reject(new Error('PRIVATE_UI_GATEWAY_PAYLOAD_DO_NOT_RENDER'));
    else recovery.resolve({ kind: 'productivity.task.reconciled', outcome: 'recovered', fault: { ...source(command.sessionId),
      state: 'resolved', revision: command.expectedRevision + 2 } });
  }
} });
function Fixture() {
  const [sessionId, setSessionId] = useState('fixture-a'); select = setSessionId;
  return <section className="simple-module-panel productivity-panel" style={{ width: '100%', height: '100vh' }}>
    <p>【UI 夹具】仅验证延迟响应、恢复反馈与窄面板。</p>
    <ProductivityTaskFaults key={sessionId} faults={faults} workspaceId="fixture-workspace" sessionId={sessionId}
      refreshToken={0} onReconciled={() => {}} openSession={async id => { selected.push(id); }} />
  </section>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
