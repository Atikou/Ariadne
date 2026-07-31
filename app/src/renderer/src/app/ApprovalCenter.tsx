import { useEffect, useMemo, useState } from 'react';
import { FolderLock, ListChecks, ShieldCheck } from 'lucide-react';
import type {
  AgentCapability,
  AgentProposal,
  PermissionRequest,
  PlanHandoff,
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
import { resolveApprovalSessionId } from '@shared/conversation-approval-state';
import { PlanContractView } from '@renderer/modules/agent-plan/PlanContractView';

type PendingApproval =
  | { kind: 'proposal'; id: string; createdAt: string; proposal: AgentProposal }
  | { kind: 'permission'; id: string; createdAt: string; request: PermissionRequest }
  | { kind: 'plan'; id: string; createdAt: string; handoff: PlanHandoff };

export function ConversationApprovalCards(
  { services, sessionId }: { services: ModuleServices; sessionId: string | null },
): React.JSX.Element | null {
  const snapshot = useRuntimeSnapshot(services.runtime);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccessMode>('write');
  const pending = useMemo<PendingApproval[]>(() => {
    if (!sessionId) return [];
    const belongsToSession = (candidateSessionId: string | undefined, runId?: string): boolean =>
      resolveApprovalSessionId({ sessionId: candidateSessionId, runId }, snapshot.runs) === sessionId;
    return [
      ...snapshot.proposals
        .filter((proposal) =>
          proposal.status === 'pending' && belongsToSession(proposal.sessionId))
        .map((proposal) => ({
          kind: 'proposal' as const,
          id: proposal.proposalId,
          createdAt: proposal.createdAt,
          proposal
        })),
      ...snapshot.permissions
        .filter((request) =>
          request.status === 'pending' && belongsToSession(request.sessionId, request.runId))
        .map((request) => ({
          kind: 'permission' as const,
          id: request.requestId,
          createdAt: request.createdAt,
          request
        })),
      ...snapshot.planHandoffs
        .filter((handoff) =>
          handoff.status === 'pending' && belongsToSession(handoff.sessionId, handoff.runId))
        .map((handoff) => ({
          kind: 'plan' as const,
          id: handoff.handoffId,
          createdAt: handoff.createdAt,
          handoff
        }))
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [
    sessionId,
    snapshot.permissions,
    snapshot.planHandoffs,
    snapshot.proposals,
    snapshot.runs,
  ]);

  useEffect(() => {
    void services.agentSettings.load()
      .then((settings) => setWorkspaceAccess(settings.workspaceAccess))
      .catch(() => undefined);
    return services.events.subscribe('chat:workspace-access-changed', setWorkspaceAccess);
  }, [services]);

  if (pending.length === 0) return null;

  return (
    <div className="conversation-approval-stack" role="region" aria-live="polite" aria-label="待确认操作">
      {pending.map((current) => {
        const heading = approvalHeading(current.kind);
        return <section className="approval-center" key={current.id} aria-label={heading.title}>
          <header className="approval-center-header">
            <span className="approval-center-icon"><ShieldCheck size={16} /></span>
            <div>
              <strong>{heading.title}</strong>
              <small>{heading.subtitle}</small>
            </div>
          </header>
          {current.kind === 'proposal' && <AgentProposalApproval
            proposal={current.proposal}
            runtime={services.runtime}
            workspaceAccess={workspaceAccess}
          />}
          {current.kind === 'permission' && <PermissionRequestApproval
            request={current.request}
            runtime={services.runtime}
          />}
          {current.kind === 'plan' && <PlanHandoffApproval
            handoff={current.handoff}
            runtime={services.runtime}
          />}
        </section>;
      })}
    </div>
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
  const approvable = handoff.plan.planState === 'ready_for_confirmation'
    && handoff.plan.completeness === 'complete'
    && !handoff.plan.qualityIssues.some((issue) => issue.severity === 'critical');

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
      <strong><ListChecks size={16} />{handoff.plan.title}</strong>
      <span>Plan v{handoff.plan.version} · {handoff.plan.steps.length} 步</span>
    </div>
    <PlanContractView plan={handoff.plan} compact />
    {!approvable && <p className="approval-center-error">计划契约不完整或未通过质量校验，不能批准。</p>}
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting} onClick={() => void respond('reject')}>拒绝</button>
      <button type="button" className="primary-button" disabled={submitting || !approvable} onClick={() => void respond('approve')}>
        <ShieldCheck size={13} />批准 Plan v{handoff.plan.version}
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
