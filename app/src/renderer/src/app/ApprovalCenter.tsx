import { useEffect, useMemo, useState } from 'react';
import { FolderLock, ListChecks, RotateCw, ShieldCheck } from 'lucide-react';
import type {
  AgentCapability,
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
  RunSummary,
  WorkspaceAccessMode
} from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import {
  runtimeRequestErrorMessage,
  useRuntimeSnapshot,
  type RuntimeStore
} from '@renderer/core/runtime/runtime-store';
import { formatRisk } from '@renderer/core/runtime/runtime-labels';
import {
  capabilitiesForWorkspaceAccess,
  capabilityAllowedInWorkspace,
  commonApprovalScopes,
  type ApprovalScope
} from '@renderer/modules/chat/permission-decision-policy';

type PendingApproval =
  | { kind: 'proposal'; id: string; createdAt: string; proposal: AgentProposal }
  | { kind: 'permission'; id: string; createdAt: string; request: PermissionRequest }
  | { kind: 'plan'; id: string; createdAt: string; handoff: PlanHandoff }
  | { kind: 'permission_resume'; id: string; createdAt: string; request: PermissionRequest; run: RunSummary }
  | { kind: 'plan_resume'; id: string; createdAt: string; handoff: PlanHandoff; run: RunSummary };

export function ApprovalCenter({ services }: { services: ModuleServices }): React.JSX.Element | null {
  const snapshot = useRuntimeSnapshot(services.runtime);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccessMode>('write');
  const pending = useMemo<PendingApproval[]>(() => {
    const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
    return [
      ...snapshot.proposals
        .filter((proposal) => proposal.status === 'pending')
        .map((proposal) => ({
          kind: 'proposal' as const,
          id: proposal.proposalId,
          createdAt: proposal.createdAt,
          proposal
        })),
      ...snapshot.permissions
        .filter((request) => request.status === 'pending')
        .map((request) => ({
          kind: 'permission' as const,
          id: request.requestId,
          createdAt: request.createdAt,
          request
        })),
      ...snapshot.planHandoffs
        .filter((handoff) => handoff.status === 'pending')
        .map((handoff) => ({
          kind: 'plan' as const,
          id: handoff.handoffId,
          createdAt: handoff.createdAt,
          handoff
        })),
      ...snapshot.permissions.flatMap((request) => {
        const run = runs.get(request.runId);
        return request.status === 'approved' && run?.status === 'waiting_permission'
          ? [{
              kind: 'permission_resume' as const,
              id: request.requestId,
              createdAt: request.createdAt,
              request,
              run
            }]
          : [];
      }),
      ...snapshot.planHandoffs.flatMap((handoff) => {
        const run = runs.get(handoff.runId);
        return handoff.status === 'approved' && run?.status === 'waiting_plan_handoff'
          ? [{
              kind: 'plan_resume' as const,
              id: handoff.handoffId,
              createdAt: handoff.createdAt,
              handoff,
              run
            }]
          : [];
      })
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [snapshot.permissions, snapshot.planHandoffs, snapshot.proposals, snapshot.runs]);

  useEffect(() => {
    void services.agentSettings.load()
      .then((settings) => setWorkspaceAccess(settings.workspaceAccess))
      .catch(() => undefined);
    return services.events.subscribe('chat:workspace-access-changed', setWorkspaceAccess);
  }, [services]);

  const current = pending[0];
  if (!current) return null;
  const heading = approvalHeading(current.kind);

  return (
    <aside className="approval-center" role="region" aria-live="polite" aria-label={heading.title}>
      <header className="approval-center-header">
        <span className="approval-center-icon"><ShieldCheck size={16} /></span>
        <div>
          <strong>{heading.title}</strong>
          <small>{heading.subtitle}</small>
        </div>
        {pending.length > 1 && <span className="approval-center-count">待处理 {pending.length}</span>}
      </header>
      {current.kind === 'proposal' && <AgentProposalApproval
            key={current.id}
            proposal={current.proposal}
            runtime={services.runtime}
            workspaceAccess={workspaceAccess}
          />}
      {current.kind === 'permission' && <PermissionRequestApproval
        key={current.id}
        request={current.request}
        runtime={services.runtime}
      />}
      {current.kind === 'plan' && <PlanHandoffApproval
        key={current.id}
        handoff={current.handoff}
        runtime={services.runtime}
      />}
      {current.kind === 'permission_resume' && <ResumeApproval
        key={current.id}
        title={current.request.title}
        detail={current.run.detail}
        onResume={() => services.runtime.resumePermission(current.request.requestId)}
      />}
      {current.kind === 'plan_resume' && <ResumeApproval
        key={current.id}
        title={current.handoff.title}
        detail={current.run.detail}
        onResume={() => services.runtime.resumePlan(current.handoff.handoffId)}
      />}
    </aside>
  );
}

function AgentProposalApproval({ proposal, runtime, workspaceAccess }: {
  proposal: AgentProposal;
  runtime: RuntimeStore;
  workspaceAccess: WorkspaceAccessMode;
}): React.JSX.Element {
  const [allowedCapabilities, setAllowedCapabilities] = useState<AgentCapability[]>(
    capabilitiesForWorkspaceAccess(proposal.requestedCapabilities, workspaceAccess)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceId = proposal.workspaceIds[0];
  const sessionReadOnly = proposal.risk === 'read-only'
    && proposal.requestedCapabilities.length === 1
    && proposal.requestedCapabilities[0] === 'file-read';

  useEffect(() => {
    setAllowedCapabilities((current) => current.filter((capability) => (
      proposal.requestedCapabilities.includes(capability)
      && capabilityAllowedInWorkspace(capability, workspaceAccess)
    )));
  }, [proposal.requestedCapabilities, workspaceAccess]);

  const respond = async (
    decision: 'approve_once' | 'allow_session_read_only' | 'reject'
  ): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (decision === 'reject') {
        await runtime.respondToProposal(proposal.proposalId, decision);
      } else if (decision === 'allow_session_read_only') {
        if (!workspaceId) throw new Error('该请求没有可授权的工作区。');
        await runtime.respondToProposal(proposal.proposalId, decision, { workspaceId });
      } else {
        if (!workspaceId || allowedCapabilities.length === 0) throw new Error('请至少选择一项可授权能力。');
        await runtime.respondToProposal(proposal.proposalId, decision, {
          allowedCapabilities,
          workspaceId,
          workspaceAccess
        });
      }
    } catch (responseError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(responseError, '提交授权决定失败。'));
    }
  };

  const toggleCapability = (capability: AgentCapability): void => {
    if (!capabilityAllowedInWorkspace(capability, workspaceAccess)) return;
    setAllowedCapabilities((current) => current.includes(capability)
      ? current.filter((candidate) => candidate !== capability)
      : proposal.requestedCapabilities.filter((candidate) => current.includes(candidate) || candidate === capability));
  };

  return <div className="approval-center-body">
    <div className="approval-center-title"><strong>{proposal.title}</strong><span>{proposalRiskLabel(proposal.risk)}</span></div>
    <p>{proposal.reason}</p>
    <dl className="approval-context">
      <div><dt>原始请求</dt><dd>{proposal.originalRequest}</dd></div>
      <div><dt>工作区</dt><dd>{proposal.workspaceIds.join('、')}</dd></div>
      <div><dt>作用域</dt><dd>{proposal.requestedScopes.join('、')}</dd></div>
    </dl>
    <fieldset className="approval-capability-list" disabled={submitting}>
      <legend>本次允许的能力</legend>
      {proposal.requestedCapabilities.map((capability) => <label key={capability}>
        <input
          type="checkbox"
          checked={allowedCapabilities.includes(capability)}
          disabled={submitting || !capabilityAllowedInWorkspace(capability, workspaceAccess)}
          onChange={() => toggleCapability(capability)}
        />
        <span>{agentCapabilityLabel(capability)}</span>
      </label>)}
    </fieldset>
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting} onClick={() => void respond('reject')}>拒绝</button>
      {sessionReadOnly && <button type="button" className="secondary-button" disabled={submitting || !workspaceId} onClick={() => void respond('allow_session_read_only')}>本会话只读</button>}
      <button type="button" className="primary-button" disabled={submitting || !workspaceId || allowedCapabilities.length === 0} onClick={() => void respond('approve_once')}>
        <ShieldCheck size={14} />仅本次批准
      </button>
    </div>
  </div>;
}

function PermissionRequestApproval({ request, runtime }: {
  request: PermissionRequest;
  runtime: RuntimeStore;
}): React.JSX.Element {
  const [selectedIds, setSelectedIds] = useState(() => request.permissionItems.map((item) => item.itemId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedItems = request.permissionItems.filter((item) => selectedIds.includes(item.itemId));
  const scopes = commonApprovalScopes(selectedItems);
  const hasWorkspaceContext = Boolean(request.workspaceId && request.workspaceLabel);

  const respond = async (scope: ApprovalScope | 'deny'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const decision = scope === 'deny'
        ? 'deny' as const
        : scope === 'once'
          ? 'allow_once' as const
          : scope === 'session'
            ? 'allow_session' as const
            : scope === 'project'
              ? 'allow_project' as const
              : 'allow_workspace' as const;
      await runtime.respondToPermission(request, decision, scope === 'deny' ? [] : selectedIds);
    } catch (responseError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(responseError, '提交授权决定失败。'));
    }
  };

  return <div className="approval-center-body">
    <div className="approval-center-title">
      <strong><FolderLock size={16} />{request.title}</strong>
      <span>{request.permissionItems.length} 项</span>
    </div>
    <p>{request.reason}</p>
    <p><small>授权工作区：{request.workspaceLabel ?? request.workspaceId ?? '无法确认'}</small></p>
    <ul className="approval-permission-list">
      {request.permissionItems.map((item) => <li key={item.itemId}>
        <label>
          <input
            type="checkbox"
            disabled={submitting}
            checked={selectedIds.includes(item.itemId)}
            onChange={() => setSelectedIds((current) => current.includes(item.itemId)
              ? current.filter((id) => id !== item.itemId)
              : [...current, item.itemId])}
          />
          <span><b>{item.capability}</b><code>{item.targetLabel}</code><small>{item.reason} · {formatRisk(item.risk)}</small></span>
        </label>
      </li>)}
    </ul>
    {selectedItems.length === 0 && <p className="approval-center-error">至少选择一个权限项才能批准。</p>}
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting} onClick={() => void respond('deny')}>拒绝</button>
      {scopes.includes('workspace') && <button type="button" className="secondary-button" disabled={submitting || !hasWorkspaceContext} onClick={() => void respond('workspace')}>此工作区</button>}
      {scopes.includes('project') && <button type="button" className="secondary-button" disabled={submitting || !hasWorkspaceContext} onClick={() => void respond('project')}>本项目</button>}
      {scopes.includes('session') && <button type="button" className="secondary-button" disabled={submitting} onClick={() => void respond('session')}>本次会话</button>}
      {scopes.includes('once') && <button type="button" className="primary-button" disabled={submitting} onClick={() => void respond('once')}><ShieldCheck size={13} />允许一次</button>}
    </div>
  </div>;
}

function PlanHandoffApproval({ handoff, runtime }: {
  handoff: PlanHandoff;
  runtime: RuntimeStore;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await runtime.respondToPlan(handoff.handoffId, decision);
    } catch (responseError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(responseError, '提交计划决定失败。'));
    }
  };

  return <div className="approval-center-body">
    <div className="approval-center-title">
      <strong><ListChecks size={16} />{handoff.title}</strong>
      <span>{handoff.steps.length} 步</span>
    </div>
    <p>{handoff.summary}</p>
    <ol className="approval-permission-list">
      {handoff.steps.map((step) => <li key={step.stepId}>
        <span><b>{step.title}</b>{step.detail && <small>{step.detail}</small>}</span>
      </li>)}
    </ol>
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting} onClick={() => void respond('reject')}>拒绝</button>
      <button type="button" className="primary-button" disabled={submitting} onClick={() => void respond('approve')}>
        <ShieldCheck size={13} />批准计划
      </button>
    </div>
  </div>;
}

function ResumeApproval({ title, detail, onResume }: {
  title: string;
  detail: string | undefined;
  onResume: () => Promise<void>;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resume = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onResume();
    } catch (resumeError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(resumeError, '恢复 Agent 运行失败。'));
    }
  };

  return <div className="approval-center-body">
    <div className="approval-center-title">
      <strong><RotateCw size={16} />{title}</strong>
      <span>可重试</span>
    </div>
    <p>{detail ?? '权限或计划已经批准，但上次恢复没有完成。暂停快照仍然保留，可以从原位置继续。'}</p>
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="primary-button" disabled={submitting} onClick={() => void resume()}>
        <RotateCw size={13} />重新继续
      </button>
    </div>
  </div>;
}

function approvalHeading(kind: PendingApproval['kind']): { title: string; subtitle: string } {
  switch (kind) {
    case 'proposal':
      return { title: '启动 Agent', subtitle: '确认任务和临时能力范围' };
    case 'permission':
      return { title: '具体操作授权', subtitle: '确认即将执行的工具和目标' };
    case 'plan':
      return { title: '执行计划确认', subtitle: '确认计划后进入执行阶段' };
    case 'permission_resume':
    case 'plan_resume':
      return { title: '恢复 Agent', subtitle: '上次续跑未完成，可从暂停位置重试' };
  }
}

function agentCapabilityLabel(capability: AgentCapability): string {
  switch (capability) {
    case 'file-read': return '读取文件';
    case 'file-write': return '写入文件';
    case 'browser': return '访问网络';
    case 'shell': return '运行 Shell';
  }
}

function proposalRiskLabel(risk: AgentProposal['risk']): string {
  return risk === 'read-only' ? '只读' : risk === 'write' ? '写入' : '高风险';
}
