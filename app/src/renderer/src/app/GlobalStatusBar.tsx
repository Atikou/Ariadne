import { AlertTriangle, Bot, Clock3, Cpu, KeyRound, Radio } from 'lucide-react';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { SaveStatus } from './Workspace';

export function GlobalStatusBar({ services, saveStatus }: { services: ModuleServices; saveStatus: SaveStatus }): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const available = runtime.status.availability === 'ready';
  const activeRun = runtime.runs.find((run) => run.origin === 'agent' && [
    'queued', 'running', 'waiting_permission', 'waiting_plan_handoff'
  ].includes(run.status));
  const pendingPermissions = runtime.permissions.filter((request) => request.status === 'pending').length;
  const readyModel = runtime.models.find((model) => model.availability === 'ready');
  const warningCount = (runtime.lastError ? 1 : 0) + pendingPermissions;

  return <footer className="global-status-bar"><div>
    <span className={available ? 'is-success' : 'is-danger'}>
      <Radio size={11} /> Runtime {formatRuntimeAvailability(runtime.status.availability)}
    </span>
    <span><Cpu size={11} /> {readyModel?.label ?? '暂无可用模型'}</span>
    <span><Bot size={11} /> {activeRun?.userFacingLabel ?? 'Agent 空闲'}</span>
    <span><KeyRound size={11} /> {pendingPermissions > 0 ? `${pendingPermissions} 项待确认` : '权限受控'}</span>
  </div><div>
    <span><Clock3 size={11} /> {new Date(runtime.status.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    {warningCount > 0 && <span className="is-warning"><AlertTriangle size={11} /> {warningCount}</span>}
    <span>{saveStatus === 'saving' ? '正在保存布局…' : saveStatus === 'error' ? '布局保存失败' : '布局已保存'}</span>
  </div></footer>;
}
