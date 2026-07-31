import type { AgentPlan } from '@ariadne/protocol/public';

export interface PlanContractViewProps {
  plan: AgentPlan;
  compact?: boolean;
}

export function PlanContractView({
  plan,
  compact = false
}: PlanContractViewProps): React.JSX.Element {
  return <div className={`plan-contract${compact ? ' plan-contract--compact' : ''}`}>
    <dl className="plan-contract-state" aria-label="计划状态">
      <div><dt>版本</dt><dd>Plan v{plan.version}</dd></div>
      <div><dt>计划状态</dt><dd>{planStateLabel(plan.planState)}</dd></div>
      <div><dt>执行状态</dt><dd>{executionStateLabel(plan.executionState)}</dd></div>
      <div><dt>完整性</dt><dd>{plan.completeness === 'complete' ? '完整' : '需要补充'}</dd></div>
      <div><dt>阻塞</dt><dd>{plan.blockingReasons.length > 0 ? plan.blockingReasons.join('；') : '无'}</dd></div>
    </dl>

    <PlanSection title="目标">
      <p>{plan.goal}</p>
    </PlanSection>

    <PlanSection title="已知事实">
      <ul>{plan.facts.map((fact) => <li key={fact.id}>
        <span>{fact.statement}</span>
        <small>证据：{fact.evidence}</small>
      </li>)}</ul>
    </PlanSection>

    <PlanSection title="约束与非目标">
      {plan.constraints.length > 0
        ? <ul>{plan.constraints.map((item) => <li key={item.id}>
            <span className="plan-contract-kind">{constraintLabel(item.kind)}</span>
            <span>{item.statement}</span>
          </li>)}</ul>
        : <p className="plan-contract-empty">无额外约束。</p>}
    </PlanSection>

    <PlanSection title="待确认决策">
      {plan.clarifications.length > 0
        ? <ol>{plan.clarifications.map((item) => <li key={item.id}>
            <span>{item.question}</span>
            <small>影响：{item.impact}</small>
          </li>)}</ol>
        : <p className="plan-contract-empty">无。</p>}
    </PlanSection>

    <PlanSection title="执行步骤">
      {plan.steps.length > 0
        ? <ol className="plan-contract-steps">{plan.steps.map((step) => <li key={step.id}>
            <header>
              <strong>{step.title}</strong>
              <span>{stepStatusLabel(step.status)}</span>
            </header>
            <dl>
              <div><dt>动作</dt><dd>{step.action}</dd></div>
              <div><dt>范围</dt><dd>{step.scope.join('、')}</dd></div>
              <div><dt>预期结果</dt><dd>{step.expectedOutcome}</dd></div>
              <div><dt>验证</dt><dd>{step.verification}</dd></div>
              <div><dt>依赖</dt><dd>{step.dependsOn.length > 0 ? step.dependsOn.join('、') : '无'}</dd></div>
            </dl>
          </li>)}</ol>
        : <p className="plan-contract-empty">关键决策确认前，不会冻结执行步骤。</p>}
    </PlanSection>

    <PlanSection title="完成标准">
      {plan.completionCriteria.length > 0
        ? <ul>{plan.completionCriteria.map((criterion) => <li key={criterion.id}>
            <span>{criterion.behavior}</span>
            <small>验证：{criterion.verification}</small>
          </li>)}</ul>
        : <p className="plan-contract-empty">待关键决策确认后补充。</p>}
    </PlanSection>

    {plan.qualityIssues.length > 0 && <section className="plan-contract-quality">
      <h3>质量校验</h3>
      <ul>{plan.qualityIssues.map((issue, index) => <li
        key={`${issue.code}:${issue.path ?? index}`}
        data-severity={issue.severity}
      >
        {issue.message}
      </li>)}</ul>
    </section>}
  </div>;
}

function PlanSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <section className="plan-contract-section">
    <h3>{title}</h3>
    {children}
  </section>;
}

function planStateLabel(state: AgentPlan['planState']): string {
  switch (state) {
    case 'collecting_context': return '收集上下文';
    case 'needs_clarification': return '需要澄清';
    case 'ready_for_confirmation': return '等待确认';
    case 'approved': return '已批准';
    case 'superseded': return '已被新版本替代';
  }
}

function executionStateLabel(state: AgentPlan['executionState']): string {
  switch (state) {
    case 'not_started': return '尚未开始';
    case 'in_progress': return '执行中';
    case 'blocked': return '阻塞';
    case 'completed': return '已完成';
    case 'failed': return '失败';
  }
}

function stepStatusLabel(status: AgentPlan['steps'][number]['status']): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'in_progress': return '执行中';
    case 'blocked': return '阻塞';
    case 'completed': return '已完成';
    case 'failed': return '失败';
  }
}

function constraintLabel(kind: AgentPlan['constraints'][number]['kind']): string {
  if (kind === 'constraint') return '约束';
  if (kind === 'non_goal') return '非目标';
  return '假设';
}
