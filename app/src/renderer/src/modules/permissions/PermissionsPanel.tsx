import { useState } from 'react';
import { FolderLock, RotateCw, ShieldCheck } from 'lucide-react';
import type { PermissionRequest } from '@ariadne/protocol/public';
import { useRuntimeSnapshot, type RuntimeStore } from '@renderer/core/runtime/runtime-store';
import { formatRisk } from '@renderer/core/runtime/runtime-labels';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';
import { commonApprovalScopes, type ApprovalScope } from '../chat/permission-decision-policy';


export function PermissionsPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const runtime = useRuntimeSnapshot(services.runtime);
  const pending = runtime.permissions.filter((request) => request.status === 'pending');
  const retryableRunIds = new Set(runtime.runs
    .filter((run) => run.status === 'waiting_permission')
    .map((run) => run.runId));
  const retryable = runtime.permissions.filter((request) => (
    request.status === 'approved' && retryableRunIds.has(request.runId)
  ));
  const attentionCount = pending.length + retryable.length;
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
        retryable={retryableRunIds.has(request.runId)}
      />)}
    </div>
    {runtime.permissions.length === 0 && <p className="module-empty-state">暂无权限请求。</p>}
  </section>;
}

function PermissionRequestCard({ request, runtime, retryable }: {
  request: PermissionRequest;
  runtime: RuntimeStore;
  retryable: boolean;
}): React.JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    request.permissionItems.map((item) => item.itemId)
  );
  const selectedItems = request.permissionItems.filter((item) => selectedIds.includes(item.itemId));
  const scopes = commonApprovalScopes(selectedItems);
  const respond = (scope: ApprovalScope): void => {
    const decision = scope === 'once'
      ? 'allow_once' as const
      : scope === 'session'
        ? 'allow_session' as const
        : scope === 'project'
          ? 'allow_project' as const
          : 'allow_workspace' as const;
    void runtime.respondToPermission(request, decision, selectedIds);
  };
  return <article>
    <span><FolderLock size={16} /></span>
    <div>
      <strong>{request.title}</strong>
      <p>{request.reason}</p>
      <ul className="permission-item-list">
        {request.permissionItems.map((item) => <li key={item.itemId}>
          <label>
            <input
              type="checkbox"
              disabled={request.status !== 'pending'}
              checked={selectedIds.includes(item.itemId)}
              onChange={() => setSelectedIds((current) => current.includes(item.itemId)
                ? current.filter((id) => id !== item.itemId)
                : [...current, item.itemId])}
            />
            <span><b>{item.capability}</b><code>{item.targetLabel}</code><small>{item.reason} · {formatRisk(item.risk)}</small></span>
          </label>
        </li>)}
      </ul>
      {request.status === 'pending' && <div className="rewrite-action-row permission-actions">
        <button type="button" className="rewrite-cancel-button" onClick={() => {
          void runtime.respondToPermission(request, 'deny', []);
        }}>拒绝</button>
        {scopes.includes('once') && <button type="button" className="rewrite-send-button" onClick={() => respond('once')}>
          <ShieldCheck size={13} /> 允许一次
        </button>}
        {scopes.includes('session') && <button type="button" className="rewrite-cancel-button" onClick={() => respond('session')}>本次会话</button>}
        {scopes.includes('project') && <button type="button" className="rewrite-cancel-button" onClick={() => respond('project')}>本项目</button>}
        {scopes.includes('workspace') && <button type="button" className="rewrite-cancel-button" onClick={() => respond('workspace')}>此工作区</button>}
      </div>}
      {request.status === 'pending' && selectedItems.length === 0 && <p className="permission-selection-warning">至少选择一个权限项才能批准。</p>}
      {request.status === 'approved' && retryable && <div className="rewrite-action-row permission-actions">
        <button type="button" className="rewrite-send-button" onClick={() => {
          void runtime.resumePermission(request.requestId);
        }}><RotateCw size={13} /> 重新继续</button>
      </div>}
    </div>
  </article>;
}
