import type { PublicDecisionCatalogSummary } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import { usePanelAction } from './usePanelAction';

const LABELS: Record<PublicDecisionCatalogSummary['kind'], string> = {
  permission: '权限', plan: '计划', user_question: '问题', recovery: '恢复处理', budget: '执行预算'
};

export function DecisionDetailLinks({ rows, services }: {
  rows: readonly PublicDecisionCatalogSummary[];
  services: Pick<ModuleServices, 'sessions' | 'runs' | 'decisions'>;
}): React.JSX.Element | null {
  const action = usePanelAction();
  if (rows.length === 0) return null;
  return <div className="decision-detail-links" aria-label="待确认详情">
    {rows.map(row => <button type="button" key={row.decisionId} disabled={action.pending}
      onClick={() => void action.execute(async () => {
        await services.sessions.select(row.sessionId);
        if (row.kind === 'recovery' || row.kind === 'budget') await services.runs.openDetail(row.runId);
        await services.decisions.openDetail(row.decisionId);
      })}>{LABELS[row.kind]} · {row.title} · 查看详情</button>)}
    {action.error && <p role="alert">{action.error}</p>}
  </div>;
}
