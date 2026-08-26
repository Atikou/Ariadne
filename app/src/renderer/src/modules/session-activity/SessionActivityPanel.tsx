import { CheckCircle2, CircleDot, Clock3, LoaderCircle, Wrench, XCircle } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { useRuntimeSnapshot } from '@renderer/core/runtime/runtime-store';
import { formatRunStatus } from '@renderer/core/runtime/runtime-labels';

/** Projection-native view: tool activity is read from the authoritative Run projection. */
export function SessionActivityPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const runs = runtime.runs.filter((run) => run.sessionId === runtime.selectedSessionId);
  const runIds = new Set(runs.map((run) => run.runId));
  const activities = runtime.activities
    .filter((activity) => runIds.has(activity.runId))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));

  return <section className="session-activity-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="session-activity-header">
      <div><span>SESSION ACTIVITY</span><h1 id={`${moduleId}-title`}>会话活动</h1></div>
      <div className="session-activity-runs" aria-label="本会话运行">
        {runs.map((run, index) => <div key={run.runId} className="is-active">
          <span>#{index + 1}</span><strong>{formatRunStatus(run.status)}</strong>
        </div>)}
      </div>
    </header>
    <div className="session-activity-workspace"><div className="session-activity-canvas">
      {activities.map((activity) => <article className="activity-detail-card" key={activity.activityId}>
        {activity.status === 'failed'
          ? <XCircle size={15} />
          : activity.status === 'running'
            ? <LoaderCircle className="is-spinning" size={15} />
            : <CheckCircle2 size={15} />}
        <div><strong><Wrench size={13} /> {activity.title}</strong>
          <p>{activity.summary ?? '工具调用的公开状态由 Run Projection 提供。'}</p>
          <small><Clock3 size={11} /> {new Date(activity.occurredAt).toLocaleTimeString()}</small>
        </div>
      </article>)}
      {activities.length === 0 && <div className="activity-empty"><CircleDot /> 本轮还没有工具调用。</div>}
    </div></div>
  </section>;
}
