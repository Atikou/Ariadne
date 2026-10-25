import type { TaskDirectoryRow, TaskSourceMetadata } from '@ariadne/protocol/public';

export const taskSourceLabels: Record<TaskSourceMetadata['reference']['source'], string> = {
  run: '运行', goal: '目标', workflow: '工作流', schedule: '调度定义', occurrence: '一次触发'
};
export const taskStateLabels: Record<TaskSourceMetadata['state'], string> = {
  queued: '排队中', running: '进行中', waiting_confirmation: '等待确认', blocked: '受阻', paused: '已暂停',
  recovering: '需要恢复', cancelling: '取消中', completed: '已完成', failed: '失败', cancelled: '已取消',
  scheduled: '等待触发', unknown: '状态待对账'
};
export function taskStatusTone(state: TaskSourceMetadata['state']): 'neutral' | 'success' | 'warning' | 'danger' | 'running' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'danger';
  if (['waiting_confirmation', 'blocked', 'recovering', 'unknown', 'cancelling'].includes(state)) return 'warning';
  return state === 'running' ? 'running' : 'neutral';
}
export function taskDisplayTitle(row: TaskDirectoryRow): string {
  const metadata = row.metadata, suffix = metadata.reference.sourceId.slice(-8);
  return metadata.title === 'Agent run' ? `Agent 任务 #${suffix}`
    : metadata.title === 'SubAgent task' ? `子任务 #${suffix}` : metadata.title;
}
