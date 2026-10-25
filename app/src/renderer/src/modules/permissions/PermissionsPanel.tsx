import { FolderLock, ShieldCheck } from 'lucide-react';
import {
  type RuntimePermissionDecision
} from '@renderer/core/runtime/runtime-store';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import type { DecisionFeatureStore } from '@renderer/core/runtime/features/decision-feature-store';
import { formatRisk } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { usePanelAction } from '@renderer/shared/ui/usePanelAction';
import { DecisionDetailLinks } from '@renderer/shared/ui/DecisionDetailLinks';
import { ProjectionCatalogPager } from '@renderer/shared/ui/ProjectionCatalogPager';
import { usePanelDetailFocus } from '@renderer/shared/ui/usePanelDetailFocus';

export function PermissionsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const decisions = useFeatureSnapshot(services.decisions.view);
  const attentionCount = decisions.decisionDirectory?.page.decisionKindCounts.permission ?? 0;
  const summaries = decisions.decisionDirectory?.page.rows.flatMap(row => row.feature === 'decisions' && row.dto.kind === 'permission' ? [row.dto] : []) ?? [];
  const detailedIds = new Set(decisions.permissions.map(request => request.requestId));
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header">
      <div><span>安全控制</span><h1 id={`${moduleId}-title`}>权限</h1></div>
      <StatusPill tone={attentionCount > 0 ? 'warning' : 'success'}>
        {decisions.decisionDirectory === null ? '正在读取…' : attentionCount > 0 ? `${attentionCount} 项待处理` : '权限受控'}
      </StatusPill>
    </header>
    <p className="module-scope-description">全部会话的待确认目录；选择条目可打开所属会话。</p>
    <ProjectionCatalogPager window={decisions.decisionDirectory} navigate={direction => services.decisions.navigate(direction)} label="全部待确认操作" />
    <DecisionDetailLinks rows={summaries.filter(row => !detailedIds.has(row.decisionId))} services={services} />
    {decisions.permissions.length > 0 && <h2 className="module-detail-heading">当前会话已打开的权限详情</h2>}
    <div className="permission-list">
      {decisions.permissions.map((request) => <PermissionRequestCard
        key={`${request.requestId}:${request.projectionVersion}`}
        request={request}
        decisions={services.decisions}
        selected={decisions.openedDecisionId === request.requestId}
      />)}
    </div>
    {attentionCount === 0 && decisions.decisionDirectory !== null && <p className="module-empty-state">暂无待处理权限请求。</p>}
    {attentionCount > 0 && summaries.length === 0 && <p>权限请求位于其他待确认列表页。</p>}
  </section>;
}

function PermissionRequestCard({ request, decisions, selected }: {
  request: RuntimePermissionDecision;
  decisions: DecisionFeatureStore;
  selected: boolean;
}): React.JSX.Element {
  const action = usePanelAction();
  const detail = usePanelDetailFocus(selected, request.requestId);
  return <article ref={detail} tabIndex={-1} data-decision-id={request.requestId} aria-current={selected}>
    <span><FolderLock size={16} /></span>
    <div>
      <strong>{request.title}</strong>
      <p>{request.reason}</p>
      <p><small>工具：<code>{request.toolName}</code></small></p>
      <p><small>{request.resourceSummary}</small></p>
      <p><small>资源作用域：{request.scopeIds.length > 0 ? request.scopeIds.join('、') : '无更窄资源标识'}</small></p>
      {!request.actionAvailable && <p className="module-empty-state">当前 v3 决策写入通道尚未启用；操作已安全锁定。</p>}
      <ul className="permission-item-list">
        {request.permissionItems.map((item) => <li key={item.itemId}>
          <span><b>{item.capability}</b><code>{item.targetLabel}</code><small>{item.reason} · {formatRisk(item.risk)}</small></span>
        </li>)}
      </ul>
      {request.status === 'pending' && request.actionAvailable && <div className="rewrite-action-row permission-actions">
        <button type="button" className="rewrite-cancel-button" disabled={action.pending} onClick={() => {
          void action.execute(() => decisions.respondToPermission(request, 'deny'));
        }}>拒绝</button>
        <button type="button" className="rewrite-send-button" disabled={action.pending} onClick={() => {
          void action.execute(() => decisions.respondToPermission(request, 'allow_once'));
        }}>
          <ShieldCheck size={13} /> 允许一次
        </button>
      </div>}
      {action.pending && <p role="status">正在提交权限决定…</p>}
      {action.error && <p role="alert">{action.error}</p>}
    </div>
  </article>;
}
