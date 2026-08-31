import { useMemo, useState } from 'react';
import { FolderLock, ListChecks, MessageCircleQuestion, ShieldCheck } from 'lucide-react';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import {
  runtimeRequestErrorMessage,
  type RuntimePermissionDecision,
  type RuntimePlanDecision,
  type RuntimeUserQuestionDecision,
  type RuntimeRun
} from '@renderer/core/runtime/runtime-store';
import type { DecisionFeatureStore } from '@renderer/core/runtime/features/decision-feature-store';
import { useFeatureSnapshot } from '@renderer/core/runtime/features/feature-snapshot-store';
import { formatRisk } from '@renderer/core/runtime/runtime-labels';
import { PlanContractView } from '@renderer/modules/agent-plan/PlanContractView';

type PendingApproval =
  | { kind: 'permission'; id: string; createdAt: string; request: RuntimePermissionDecision }
  | { kind: 'plan'; id: string; createdAt: string; handoff: RuntimePlanDecision }
  | { kind: 'user_question'; id: string; createdAt: string; question: RuntimeUserQuestionDecision };

export function ConversationApprovalCards(
  { services, sessionId }: { services: ModuleServices; sessionId: string | null },
): React.JSX.Element | null {
  const decisions = useFeatureSnapshot(services.decisions.view);
  const runs = useFeatureSnapshot(services.runs.view);
  const pending = useMemo<PendingApproval[]>(() => {
    if (!sessionId) return [];
    const belongsToSession = (candidateSessionId: string | undefined, runId?: string): boolean =>
      resolveProjectionApprovalSessionId(candidateSessionId, runId, runs.runs) === sessionId;
    return [
      ...decisions.permissions
        .filter((request) =>
          request.status === 'pending' && belongsToSession(request.sessionId, request.runId))
        .map((request) => ({
          kind: 'permission' as const,
          id: request.requestId,
          createdAt: request.createdAt,
          request
        })),
      ...decisions.planHandoffs
        .filter((handoff) =>
          handoff.status === 'pending' && belongsToSession(handoff.sessionId, handoff.runId))
        .map((handoff) => ({
          kind: 'plan' as const,
          id: handoff.handoffId,
          createdAt: handoff.createdAt,
          handoff
        })),
      ...decisions.userQuestions
        .filter((question) => (
          question.status === 'pending'
          && belongsToSession(question.sessionId, question.runId)
        ))
        .map((question) => ({
          kind: 'user_question' as const,
          id: question.decisionId,
          createdAt: question.createdAt,
          question
        }))
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [
    sessionId,
    decisions.permissions,
    decisions.planHandoffs,
    decisions.userQuestions,
    runs.runs,
  ]);

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
          {current.kind === 'permission' && <PermissionRequestApproval
            request={current.request}
            decisions={services.decisions}
          />}
          {current.kind === 'plan' && <PlanHandoffApproval
            handoff={current.handoff}
            decisions={services.decisions}
          />}
          {current.kind === 'user_question' && <UserQuestionAnswer
            question={current.question}
            decisions={services.decisions}
          />}
        </section>;
      })}
    </div>
  );
}

function UserQuestionAnswer({ question, decisions }: {
  question: RuntimeUserQuestionDecision;
  decisions: DecisionFeatureStore;
}): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (content: string): Promise<void> => {
    const normalized = content.trim();
    if (submitting || normalized.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await decisions.answerUserQuestion(question, normalized);
    } catch (responseError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(responseError, '提交回答失败。'));
    }
  };

  return <div className="approval-center-body">
    <div className="approval-center-title">
      <strong><MessageCircleQuestion size={16} />{question.headline}</strong>
      <span>等待回答</span>
    </div>
    <p>{question.prompt}</p>
    {question.options && <div className="approval-center-actions">
      {question.options.map((option) => <button
        type="button"
        className="secondary-button"
        key={option.optionId}
        disabled={submitting || !question.actionAvailable}
        title={option.description}
        onClick={() => void submit(`${option.optionId}: ${option.label}`)}
      >{option.label}</button>)}
    </div>}
    <textarea
      className="agent-inbox-edit"
      aria-label="回答 Agent 问题"
      value={answer}
      disabled={submitting || !question.actionAvailable}
      onChange={(event) => setAnswer(event.target.value)}
      placeholder="输入其他回答"
      rows={3}
    />
    {!question.actionAvailable && <p className="approval-center-error">当前问题已失效或回答通道不可用。</p>}
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button
        type="button"
        className="primary-button"
        disabled={submitting || !question.actionAvailable || answer.trim().length === 0}
        onClick={() => void submit(answer)}
      >提交回答</button>
    </div>
  </div>;
}

function PermissionRequestApproval({ request, decisions }: {
  request: RuntimePermissionDecision;
  decisions: DecisionFeatureStore;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await decisions.respondToPermission(
        request,
        decision === 'allow' ? 'allow_once' : 'deny'
      );
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
    <dl className="approval-context">
      <div><dt>工具</dt><dd><code>{request.toolName}</code></dd></div>
      <div><dt>资源作用域</dt><dd>{request.scopeIds.length > 0 ? request.scopeIds.join('、') : '无更窄资源标识'}</dd></div>
    </dl>
    <p><small>{request.resourceSummary}</small></p>
    {!request.actionAvailable && <p className="approval-center-error">当前 v3 决策写入通道尚未启用；操作已安全锁定。</p>}
    <ul className="approval-permission-list">
      {request.permissionItems.map((item) => <li key={item.itemId}>
        <span><b>{item.capability}</b><code>{item.targetLabel}</code><small>{item.reason} · {formatRisk(item.risk)}</small></span>
      </li>)}
    </ul>
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting || !request.actionAvailable} onClick={() => void respond('deny')}>拒绝</button>
      <button type="button" className="primary-button" disabled={submitting || !request.actionAvailable} onClick={() => void respond('allow')}><ShieldCheck size={13} />允许一次</button>
    </div>
  </div>;
}

function PlanHandoffApproval({ handoff, decisions }: {
  handoff: RuntimePlanDecision;
  decisions: DecisionFeatureStore;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvable = handoff.actionAvailable
    && handoff.status === 'pending'
    && (handoff.plan === null || (
      handoff.plan.planState === 'ready_for_confirmation'
      && handoff.plan.completeness === 'complete'
      && !handoff.plan.qualityIssues.some((issue) => issue.severity === 'critical')
    ));

  const respond = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await decisions.respondToPlan(handoff, decision);
    } catch (responseError) {
      setSubmitting(false);
      setError(runtimeRequestErrorMessage(responseError, '提交计划决定失败。'));
    }
  };

  return <div className="approval-center-body">
    <div className="approval-center-title">
      <strong><ListChecks size={16} />{handoff.title}</strong>
      <span>{handoff.plan ? `Plan v${handoff.plan.version}` : `Projection v${handoff.projectionVersion}`}</span>
    </div>
    {handoff.plan ? <PlanContractView plan={handoff.plan} compact /> : <div>
      <p>{handoff.summary}</p>
      <p><small>影响：{handoff.impactSummary}</small></p>
      <ol>{handoff.steps.map((step) => <li key={step.stepId}>
        <strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}
      </li>)}</ol>
    </div>}
    {!handoff.actionAvailable && <p className="approval-center-error">当前 v3 决策写入通道尚未启用；操作已安全锁定。</p>}
    {handoff.actionAvailable && !approvable && <p className="approval-center-error">计划契约不完整或未通过质量校验，不能批准。</p>}
    {error && <p className="approval-center-error">{error}</p>}
    <div className="approval-center-actions">
      <button type="button" className="secondary-button" disabled={submitting || !handoff.actionAvailable} onClick={() => void respond('reject')}>拒绝</button>
      <button type="button" className="primary-button" disabled={submitting || !approvable} onClick={() => void respond('approve')}>
        <ShieldCheck size={13} />批准计划
      </button>
    </div>
  </div>;
}

function resolveProjectionApprovalSessionId(
  sessionId: string | undefined,
  runId: string | undefined,
  runs: readonly RuntimeRun[]
): string | undefined {
  if (sessionId !== undefined) return sessionId;
  if (runId === undefined) return undefined;
  return runs.find((run) => run.runId === runId)?.sessionId;
}

function approvalHeading(kind: PendingApproval['kind']): { title: string; subtitle: string } {
  switch (kind) {
    case 'permission':
      return { title: '具体操作授权', subtitle: '确认即将执行的工具和目标' };
    case 'plan':
      return { title: '执行计划确认', subtitle: '确认计划后进入执行阶段' };
    case 'user_question':
      return { title: 'Agent 需要你的输入', subtitle: '回答后从同一个持久 Run 继续' };
  }
}
