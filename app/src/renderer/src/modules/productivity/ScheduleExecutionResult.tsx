import type { ScheduleOccurrencePage } from '@renderer/core/runtime/features/schedule-occurrence-feature-store';

type Execution = NonNullable<ScheduleOccurrencePage['occurrences'][number]['execution']>;
const labels: Record<Execution['status'], string> = {
  handoff_pending: '等待执行交接', starting: '正在启动', start_failed: '执行启动失败', queued: '等待执行', running: '执行中',
  waiting: '等待权限或用户决定', recovering: '等待故障恢复', waiting_children: '等待子任务', waiting_input: '等待后续输入',
  cancelling: '正在取消，等待任务结束', completed: '执行完成', failed: '执行失败', cancelled: '执行已取消'
};
export function scheduleExecutionPending(execution: Execution | null | undefined): boolean {
  return Boolean(execution && (execution.resultPending || !['start_failed','completed','failed','cancelled'].includes(execution.status)));
}
export function ScheduleExecutionResult({ execution, disabled, openSession }: {
  execution: Execution; disabled: boolean; openSession(): void;
}): React.JSX.Element {
  return <section className="schedule-execution-result" aria-label="调度实际执行结果" data-schedule-run-id={execution.runId ?? ''}>
    <strong>实际执行：{labels[execution.status]}</strong>
    {execution.runId && <small>Run：{execution.runId}</small>}
    {execution.resultPending && <p>任务已结束，正在同步会话结果。</p>}
    {execution.resultSummary !== null && <p className="schedule-execution-summary">{execution.resultSummary || '本次执行没有文本结果。'}</p>}
    {execution.status === 'start_failed' && <p>任务已送达会话，但执行未能启动。请打开会话查看原因。</p>}
    <button type="button" disabled={disabled} onClick={openSession}>打开所属会话</button>
  </section>;
}
