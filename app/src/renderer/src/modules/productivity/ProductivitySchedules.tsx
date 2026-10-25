import { useState } from 'react';
import type { ProductivityFeatureStore, ProductivitySchedule } from '@renderer/core/runtime/features/productivity-feature-store';
import { SelectMenu } from '@renderer/shared/ui/SelectMenu';
import { scheduleStatusText } from './ProductivityPresentation';

export function ProductivitySchedules({ productivity, schedules, workspaceId, sessionId, disabled, run }: {
  productivity: ProductivityFeatureStore; schedules: readonly ProductivitySchedule[]; workspaceId: string; sessionId: string;
  disabled: boolean; run(operation: () => Promise<unknown>): void;
}): React.JSX.Element {
  const services = { productivity };
  const action = { pending: disabled };
  const snapshot = !disabled;
  const [schedulePrompt, setSchedulePrompt] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [timingKind, setTimingKind] = useState<ProductivitySchedule['timing']['kind']>('once');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const timingValid = timingKind === 'once' ? Boolean(scheduleAt) && Number.isFinite(new Date(scheduleAt).getTime())
    : timingKind === 'interval' ? Number.isFinite(Number(intervalMinutes)) && Number(intervalMinutes) >= 1 / 60 && Number(intervalMinutes) <= 525600
      : Boolean(cron.trim() && timezone.trim());
  return <details className="productivity-schedules"><summary>调度任务（{schedules.length}）</summary>
      <article className="productivity-card">
        <h2>调度入口</h2>
        <input aria-label="调度任务" value={schedulePrompt} onChange={(event) => setSchedulePrompt(event.target.value)} placeholder="触发时发送的任务" />
        <SelectMenu<ProductivitySchedule['timing']['kind']> ariaLabel="调度类型" value={timingKind} onChange={setTimingKind} disabled={action.pending || !snapshot}
          options={[{ value: 'once', label: '一次性' }, { value: 'interval', label: '固定间隔' }, { value: 'cron', label: 'Cron' }]} />
        {timingKind === 'once' && <input aria-label="调度时间" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />}
        {timingKind === 'interval' && <label>间隔（分钟）<input type="number" min={1 / 60} max={525_600} step="any" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}
        {timingKind === 'cron' && <><input aria-label="Cron 表达式" value={cron} onChange={(event) => setCron(event.target.value)} /><input aria-label="调度时区" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></>}
        <button type="button" disabled={!schedulePrompt.trim() || !timingValid} onClick={() => run(async () => {
          const timing: ProductivitySchedule['timing'] = timingKind === 'once' ? { kind: 'once', at: new Date(scheduleAt).toISOString(), missPolicy: 'run_once' }
            : timingKind === 'interval' ? { kind: 'interval', intervalMs: Math.round(Number(intervalMinutes) * 60_000) }
              : { kind: 'cron', expression: cron.trim(), timezone: timezone.trim(), missPolicy: 'run_once' };
          await services.productivity.createSchedule({ workspaceId, sessionId, scheduleId: crypto.randomUUID(), prompt: schedulePrompt.trim(), timing });
          setSchedulePrompt(''); setScheduleAt('');
        })}>创建调度</button>
        <p>暂停保留尚未提交的任务；取消撤回尚未提交的任务，已开始的提交会继续结算。</p>
        <ul>{schedules.map((schedule) => <li key={schedule.scheduleId}>
          <span>{schedule.prompt}</span><small>{scheduleStatusText[schedule.status]} · {schedule.nextFireAt ?? '无下次'}</small>
          {(schedule.status === 'active' || schedule.status === 'paused') && <button type="button" onClick={() => run(() => services.productivity.transitionSchedule({ workspaceId, sessionId, scheduleId: schedule.scheduleId, expectedVersion: schedule.version, action: schedule.status === 'active' ? 'pause' : 'resume' }))}>{schedule.status === 'active' ? '暂停' : '继续'}</button>}
          {schedule.status !== 'cancelled' && <button type="button" onClick={() => run(() => services.productivity.transitionSchedule({ workspaceId, sessionId, scheduleId: schedule.scheduleId, expectedVersion: schedule.version, action: 'cancel' }))}>取消调度</button>}
        </li>)}</ul>
      </article>
  </details>;
}
