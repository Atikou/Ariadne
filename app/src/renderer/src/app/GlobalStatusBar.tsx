import { AlertTriangle, Bot, Clock3, Cpu, KeyRound, Radio } from 'lucide-react';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRuntimeAvailability } from '@renderer/core/runtime/runtime-labels';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { SaveStatus } from './Workspace';

export function GlobalStatusBar({ services, saveStatus }: { services: ModuleServices; saveStatus: SaveStatus }): React.JSX.Element {
  const diagnostics = useFeatureSnapshot(services.diagnostics.view);
  const decisions = useFeatureSnapshot(services.decisions.view);
  const models = useFeatureSnapshot(services.models.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const available = diagnostics.status.availability === 'ready';
  const activeRun = runs.runSummaries.find((run) => run.parentRunId === undefined && [
    'queued', 'running', 'waiting_decision', 'waiting_permission', 'waiting_plan_handoff', 'waiting_budget'
  ].includes(run.status));
  const pendingDecisions = decisions.decisionDirectory?.page.totalRows ?? 0;
  const activeCount = Object.entries(runs.runDirectory?.page.statusCounts ?? {})
    .filter(([status]) => !['completed', 'failed', 'cancelled'].includes(status)).reduce((sum, [, count]) => sum + (count ?? 0), 0);
  const readyModel = models.models.find((model) => model.availability === 'ready');
  const unavailableDomains = diagnostics.domainHealth.health?.domains.filter(domain => domain.availability !== 'healthy') ?? [];
  const warningCount = (diagnostics.lastError ? 1 : 0) + pendingDecisions + unavailableDomains.length;

  return <footer className="global-status-bar"><div>
    <span className={available ? 'is-success' : 'is-danger'} data-runtime-availability={diagnostics.status.availability}>
      <Radio size={11} /> Runtime {formatRuntimeAvailability(diagnostics.status.availability)}
    </span>
    {unavailableDomains.map(domain => <span key={domain.domain} className="is-warning" data-runtime-domain={domain.domain}
      title={`${domainName(domain.domain)}${domain.code === 'task_quarantined' ? '的部分任务已隔离'
        : domain.code === 'external_unavailable' ? '的依赖服务暂不可用，当前能力已降级'
        : domain.availability === 'degraded' ? '已降级' : '暂不可用'}。${recoveryMessage(domain.recovery, domain.code)}`}>
      <AlertTriangle size={11} /> {domainName(domain.domain)}{domain.availability === 'degraded' ? '受限' : '不可用'}
    </span>)}
    {available && diagnostics.domainHealth.state === 'error' && <span className="is-warning">组件健康状态暂不可读</span>}
    <span><Cpu size={11} /> {readyModel?.label ?? '暂无可用模型'}</span>
    <span><Bot size={11} /> {activeRun?.label ?? (activeCount > 0 ? `${activeCount} 项任务待处理` : runs.runDirectory === null ? '正在读取任务…' : 'Agent 空闲')}</span>
    <span><KeyRound size={11} /> {decisions.decisionDirectory === null ? '正在读取待确认操作…' : pendingDecisions > 0 ? `${pendingDecisions} 项待确认` : '权限受控'}</span>
  </div><div>
    <span><Clock3 size={11} /> {new Date(diagnostics.status.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    {warningCount > 0 && <span className="is-warning"><AlertTriangle size={11} /> {warningCount}</span>}
    <span>{saveStatus === 'saving' ? '正在保存布局…' : saveStatus === 'error' ? '布局保存失败' : '布局已保存'}</span>
  </div></footer>;
}

function domainName(domain: string): string {
  const names: Record<string, string> = { execution: '任务执行', conversation: '会话存储', projection: '投影视图',
    productivity: '任务存储', schedule: '定时任务', workflow: '工作流', goal: '目标规划', memory: '长期记忆',
    documents: '工作区文件', inference: '模型推理', journal: '命令日志' };
  return names[domain] ?? domain;
}
function recoveryMessage(recovery: string, code: string): string {
  if (code === 'external_unavailable') return '请核对对应服务是否恢复，再重试这项操作。';
  return recovery === 'reconcile' ? '请先核对已有任务的执行结果，再恢复处理。'
    : recovery === 'repair' ? '需要检查并修复对应存储，才能继续使用。'
    : recovery === 'restart' ? '请保存工作后重新启动，恢复过程会核对已有任务。' : '请检查对应模块的状态。';
}
