import { Check, ChevronRight, Clock3, TerminalSquare, Wrench, X } from 'lucide-react';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatActivityKind } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

export function ToolOutputPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const activities = runtime.activities.filter((activity) => activity.kind === 'tool').slice(-50).reverse();
  return <section className="bottom-module-panel" aria-labelledby={`${moduleId}-title`}><header><h1 id={`${moduleId}-title`}>工具输出</h1><span>最近 {activities.length} 次调用</span></header><div className="tool-call-table">
    {activities.map((activity) => <div className={`tool-call-row${activity.status === 'failed' ? ' is-failed' : ''}`} key={activity.activityId}>
      {activity.status === 'failed' ? <X size={14} /> : <Check size={14} />}<Wrench size={14} /><strong>{activity.title}</strong><code>{activity.summary ?? formatActivityKind(activity.kind)}</code><span><Clock3 size={11} /> {new Date(activity.occurredAt).toLocaleTimeString()}</span><ChevronRight size={13} />
    </div>)}
    {activities.length === 0 && <div className="tool-call-row"><TerminalSquare size={14} /><TerminalSquare size={14} /><strong>暂无工具调用</strong><code>Agent 活动将在这里显示。</code></div>}
  </div></section>;
}
