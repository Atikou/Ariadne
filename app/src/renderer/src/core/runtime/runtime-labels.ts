import type {
  PermissionRequest,
  RunActivity,
  RunSummary,
  RuntimeStatus,
} from '@ariadne/protocol/public';

const runtimeAvailabilityLabels: Record<RuntimeStatus['availability'], string> = {
  stopped: '已停止',
  starting: '启动中',
  ready: '就绪',
  degraded: '降级运行',
  restarting: '重新启动中',
  crashed: '已崩溃',
  disabled: '已停用'
};

const runStatusLabels: Record<RunSummary['status'], string> = {
  queued: '排队中',
  running: '执行中',
  waiting_permission: '等待权限确认',
  waiting_plan_handoff: '等待计划确认',
  waiting_budget: '等待追加预算',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

const riskLabels: Record<PermissionRequest['permissionItems'][number]['risk'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险'
};

export function formatRuntimeAvailability(availability: RuntimeStatus['availability']): string {
  return runtimeAvailabilityLabels[availability];
}

export function formatRunStatus(status: RunSummary['status']): string {
  return runStatusLabels[status];
}

export function formatActivityKind(activity: RunActivity): string {
  if (activity.activityType === 'tool') return '工具';
  return activity.kind === 'context_compaction' ? '上下文压缩' : '工作上下文裁剪';
}

export function formatRisk(risk: PermissionRequest['permissionItems'][number]['risk']): string {
  return riskLabels[risk];
}
