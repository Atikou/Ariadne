import { FolderLock, ShieldCheck } from 'lucide-react';
import {
  useRuntimeSnapshot,
  type RuntimePermissionDecision,
  type RuntimeStore
} from '@renderer/core/runtime/runtime-store';
import { formatRisk } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';

export function PermissionsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const pending = runtime.permissions.filter((request) => request.status === 'pending');
  const attentionCount = pending.length;
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header">
      <div><span>安全控制</span><h1 id={`${moduleId}-title`}>权限</h1></div>
      <StatusPill tone={attentionCount > 0 ? 'warning' : 'success'}>
        {attentionCount > 0 ? `${attentionCount} 项待处理` : '权限受控'}
      </StatusPill>
    </header>
    <div className="permission-list">
      {runtime.permissions.map((request) => <PermissionRequestCard
        key={request.requestId}
        request={request}
        runtime={services.runtime}
      />)}
    </div>
    {runtime.permissions.length === 0 && <p className="module-empty-state">暂无权限请求。</p>}
  </section>;
}

function PermissionRequestCard({ request, runtime }: {
  request: RuntimePermissionDecision;
  runtime: RuntimeStore;
}): React.JSX.Element {
  return <article>
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
        <button type="button" className="rewrite-cancel-button" onClick={() => {
          void runtime.respondToPermission(request, 'deny');
        }}>拒绝</button>
        <button type="button" className="rewrite-send-button" onClick={() => {
          void runtime.respondToPermission(request, 'allow_once');
        }}>
          <ShieldCheck size={13} /> 允许一次
        </button>
      </div>}
    </div>
  </article>;
}
