import { ProductivityCommandRejected } from './ProductivityCommandRejected.js';
import { createHash } from 'node:crypto';
import { conversationMessageReferenceSchema, publicProjectionCanonicalIdSchema, runtimeResultSchema,
  type ProductivityCommand, type ProductivityResult } from '@ariadne/protocol/public';
import { z } from 'zod';
import type { GoalPlannerResultSource } from '../../control/ports/GoalPlanningAuthority.js';
import { goalDecisionSchema, type GoalDecision } from '@ariadne/protocol/host';
import type { FrozenConversationContext } from './conversation/SqliteConversationNavigationStore.js';
import { assertTodoDependencies } from './WorkflowDependencies.js';
import { workflowIdFor, type WorkflowAgentTask, type WorkflowExecutionRecord } from './SqliteWorkflowExecution.js';
import { productivityDependencyPromptOverhead } from '../../conversation/ProductivityTaskPrompt.js';

type Goal = Extract<ProductivityResult, { kind: 'goal.updated' }>['goal'];
type Todo = Extract<ProductivityResult, { kind: 'todo.snapshot.replaced' }>['items'][number];
export interface GoalPlannerTask extends WorkflowAgentTask {
  readonly attempt: number;
  readonly phase: 'planning' | 'verifying';
  readonly todoRevision: number | null;
  readonly outcome?: 'completed' | 'failed' | 'cancelled';
  readonly decision?: { readonly idempotencyKey: string; readonly effectId: string; readonly runId: string;
    readonly fingerprint: string; readonly value: GoalDecision };
  readonly source?: GoalPlannerResultSource;
}
export interface GoalExecutionRecord extends Goal {
  readonly agentExecution?: {
    readonly status: NonNullable<Goal['autonomy']>['status'];
    readonly generation: number;
    readonly criteria: readonly string[];
    readonly context: FrozenConversationContext;
    readonly maxConcurrency: number;
    readonly deadlineAt: string;
    readonly tasks: readonly GoalPlannerTask[];
    readonly workflowIds: readonly string[];
    readonly summary: string;
    readonly completedBy?: 'verification' | 'user';
    readonly stopTarget?: 'paused' | 'blocked' | 'complete';
  };
}
export interface GoalAutonomyStoreCallbacks {
  readGoal(id: string): GoalExecutionRecord | null;
  writeGoal(goal: GoalExecutionRecord, now: string): void;
  readTodos(id: string): { revision: number; items: Todo[] } | null;
  readWorkflow(id: string): WorkflowExecutionRecord | null;
  replaceTodos(command: Extract<ProductivityCommand, { kind: 'todo.snapshot.replace' }>, now: string): void;
  startWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.start' }>, now: string, context: FrozenConversationContext): void;
  cancelWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.cancel' }>, now: string): void;
}
const reference = conversationMessageReferenceSchema;
const taskSchema = z.object({ todoId: publicProjectionCanonicalIdSchema, title: z.string().min(1).max(2_000),
  prompt: z.string().min(1).max(100_000), sessionId: publicProjectionCanonicalIdSchema, messageId: publicProjectionCanonicalIdSchema,
  createCommandId: publicProjectionCanonicalIdSchema, submitCommandId: publicProjectionCanonicalIdSchema,
  status: z.enum(['unclaimed', 'claimed', 'submitted', 'terminal']), attempt: z.number().int().positive(), phase: z.enum(['planning', 'verifying']),
  todoRevision: z.number().int().positive().nullable(), outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
  submissionAccepted: z.literal(true).optional(), runId: publicProjectionCanonicalIdSchema.optional(),
  resultRunVersion: z.number().int().positive().optional(), resultMessage: reference.optional(),
  dependencyMessages: z.array(z.object({ todoId: publicProjectionCanonicalIdSchema, reference }).strict()).max(256).optional(),
  decision: z.object({ idempotencyKey: publicProjectionCanonicalIdSchema, effectId: publicProjectionCanonicalIdSchema,
    runId: publicProjectionCanonicalIdSchema, fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u), value: goalDecisionSchema }).strict().optional(),
  source: z.object({ runId: publicProjectionCanonicalIdSchema, runVersion: z.number().int().positive(),
    sessionVersion: z.number().int().positive(), message: reference }).strict().optional()
}).strict();
const executionSchema = z.object({ status: z.enum(['planning', 'executing', 'verifying', 'stopping', 'paused', 'blocked', 'complete']),
  generation: z.number().int().positive(),
  criteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(32),
  context: z.object({ sourceSessionId: publicProjectionCanonicalIdSchema, sourceSessionVersion: z.number().int().positive(), boundary: reference.optional() }).strict()
    .refine(context => context.boundary === undefined || context.boundary.sessionId === context.sourceSessionId),
  maxConcurrency: z.number().int().min(1).max(16), deadlineAt: z.string().datetime({ offset: true }),
  tasks: z.array(taskSchema).min(1).max(20_001), workflowIds: z.array(publicProjectionCanonicalIdSchema).max(10_000),
  summary: z.string().max(4_000), stopTarget: z.enum(['paused', 'blocked', 'complete']).optional(),
  completedBy: z.enum(['verification', 'user']).optional()
}).strict();

export function projectGoal(record: GoalExecutionRecord): Goal {
  const { agentExecution, ...goal } = record;
  if (agentExecution === undefined) return goal;
  const task = agentExecution.tasks.at(-1)!;
  return { ...goal, autonomy: { status: agentExecution.status, criteria: [...agentExecution.criteria], deadlineAt: agentExecution.deadlineAt,
    maxConcurrency: agentExecution.maxConcurrency, plannerAttempts: agentExecution.tasks.length,
    sessionId: task.submissionAccepted ? task.sessionId : null, runId: task.runId ?? null,
    workflowId: agentExecution.workflowIds.at(-1) ?? null, summary: agentExecution.summary,
    ...(agentExecution.completedBy === undefined ? {} : { completedBy: agentExecution.completedBy }),
    ...(agentExecution.status === 'complete' && agentExecution.completedBy === 'verification' && task.decision?.value.decision === 'complete'
      ? { assessment: task.decision.value.checks.map(check => ({ criterion: check.criterion, status: 'passed' as const, evidence: check.evidence })) } : {}) } };
}
export function parseGoalExecutionRecord(value: unknown): GoalExecutionRecord {
  const goal = value as GoalExecutionRecord;
  if (goal === null || typeof goal !== 'object') throw new Error('goal_execution_authority_invalid');
  const { agentExecution, ...publicPart } = goal;
  if (!runtimeResultSchema.safeParse({ kind: 'goal.updated', goal: publicPart }).success) throw new Error('goal_execution_authority_invalid');
  if (agentExecution === undefined) {
    if (goal.autonomy !== undefined) throw new Error('goal_execution_authority_invalid');
    return goal;
  }
    if (!executionSchema.safeParse(agentExecution).success || JSON.stringify(projectGoal(goal)) !== JSON.stringify(publicPart)
    || (agentExecution.completedBy !== undefined && (goal.status !== 'complete' || agentExecution.status !== 'complete'))
    || (agentExecution.completedBy === 'verification' && (agentExecution.tasks.at(-1)?.outcome !== 'completed'
      || agentExecution.tasks.at(-1)?.decision?.value.decision !== 'complete'))
    || agentExecution.tasks.some((task, index) => task.attempt !== index + 1
      || task.todoId !== goalExecutionId('planner', goal, String(task.attempt))
      || task.sessionId !== goalExecutionId('session', goal, String(task.attempt))
      || task.messageId !== goalExecutionId('message', goal, String(task.attempt))
      || task.createCommandId !== goalExecutionId('create', goal, String(task.attempt))
      || task.submitCommandId !== goalExecutionId('submit', goal, String(task.attempt))
      || (task.status === 'submitted' && task.submissionAccepted !== true)
      || (task.runId !== undefined && task.submissionAccepted !== true)
      || (index < agentExecution.tasks.length - 1 && task.status !== 'terminal')
      || (task.outcome !== undefined && task.status !== 'terminal')
      || (task.outcome === 'completed' && task.source === undefined)
      || (task.source !== undefined && (task.source.runId !== task.runId || task.source.message.sessionId !== task.sessionId || task.status !== 'terminal'))
      || (task.decision !== undefined && task.runId !== undefined && task.decision.runId !== task.runId))) {
    throw new Error('goal_execution_authority_invalid');
  }
  return goal;
}

/** Transaction-local owner for the autonomous Goal state machine and its immutable model decisions. */
export class SqliteGoalAutonomy {
  public constructor(private readonly store: GoalAutonomyStoreCallbacks) {}
  public start(goal: GoalExecutionRecord, command: Extract<ProductivityCommand, { kind: 'goal.autonomy.start' }>, context: FrozenConversationContext, now: string): GoalExecutionRecord {
    if (goal.version !== command.expectedVersion) throw new ProductivityCommandRejected('goal_version_conflict');
    if (goal.agentExecution !== undefined && !['paused', 'blocked', 'complete'].includes(goal.agentExecution.status)) throw new ProductivityCommandRejected('goal_autonomy_already_started');
    if (goal.agentExecution?.tasks.some(task => task.status !== 'terminal')) throw new ProductivityCommandRejected('goal_planner_still_active');
    if (goal.roundsUsed >= goal.roundCap) throw new ProductivityCommandRejected('goal_round_cap_reached');
    if (Date.parse(command.deadlineAt) <= Date.parse(now)) throw new ProductivityCommandRejected('goal_deadline_invalid');
    if (new Set(command.criteria).size !== command.criteria.length) throw new ProductivityCommandRejected('goal_criterion_duplicate');
    const initial: GoalExecutionRecord = { ...goal, status: 'active', agentExecution: { status: 'planning', generation: goal.version + 1, criteria: [...command.criteria], context,
      maxConcurrency: command.maxConcurrency, deadlineAt: command.deadlineAt, tasks: [], workflowIds: [], summary: '' } };
    const task = this.createTask(initial, 'planning');
    return this.save({ ...initial, agentExecution: { ...initial.agentExecution!, tasks: [task] } }, now);
  }
  public transition(goal: GoalExecutionRecord, action: 'pause' | 'resume', now: string): GoalExecutionRecord {
    const execution = goal.agentExecution;
    if (execution === undefined) throw new ProductivityCommandRejected('goal_autonomy_not_started');
    if (action === 'pause') {
      if (execution.status === 'paused' || execution.status === 'complete') return goal;
      return this.requestStop(goal, 'paused', now);
    }
    if (!['paused', 'blocked'].includes(execution.status)) throw new ProductivityCommandRejected('goal_autonomy_not_resumable');
    if ((!execution.workflowIds.length && goal.roundsUsed >= goal.roundCap) || execution.tasks.length >= goal.roundCap * 2 + 1) throw new ProductivityCommandRejected('goal_round_cap_reached');
    if (execution.tasks.some(task => task.status !== 'terminal')) throw new ProductivityCommandRejected('goal_planner_still_active');
    if (Date.parse(execution.deadlineAt) <= Date.parse(now)) throw new ProductivityCommandRejected('goal_deadline_exceeded');
    const { stopTarget: _stop, ...resumed } = execution;
    const phase = execution.workflowIds.length ? 'verifying' : 'planning';
    const resumedGoal: GoalExecutionRecord = { ...goal, status: 'active', agentExecution: { ...resumed, status: phase } };
    return this.save({ ...resumedGoal, agentExecution: { ...resumedGoal.agentExecution!, tasks: [...execution.tasks, this.createTask(resumedGoal, phase)] } }, now);
  }
  public requestStop(goal: GoalExecutionRecord, target: 'paused' | 'blocked' | 'complete', now: string): GoalExecutionRecord {
    if (goal.agentExecution === undefined) throw new ProductivityCommandRejected('goal_autonomy_not_started');
    if (goal.agentExecution.status === 'stopping' && goal.agentExecution.stopTarget === target) return goal;
    const requested = this.save({ ...goal, status: 'paused', agentExecution: { ...goal.agentExecution!, status: 'stopping', stopTarget: target } }, now);
    this.cancelWorkflow(requested, now); return requested;
  }
  public claim(goalId: string, attempt: number, now: string): GoalPlannerTask | null {
    const goal = this.require(goalId); const task = this.task(goal, attempt);
    if (task.status !== 'unclaimed') return task.status === 'terminal' ? null : task;
    if (goal.status !== 'active' || !['planning', 'verifying'].includes(goal.agentExecution!.status)
      || Date.parse(goal.agentExecution!.deadlineAt) <= Date.parse(now)) return null;
    const claimed = { ...task, status: 'claimed' as const }; this.replaceTask(goal, claimed, now); return claimed;
  }
  public submitted(goalId: string, attempt: number, runId: string | undefined, now: string): void {
    const goal = this.require(goalId); const task = this.task(goal, attempt);
    if (task.status === 'unclaimed') throw new Error('goal_planner_not_claimed');
    if (task.runId !== undefined && runId !== undefined && task.runId !== runId) throw new Error('goal_planner_run_conflict');
    if (task.decision !== undefined && runId !== undefined && task.decision.runId !== runId) throw new Error('goal_planner_run_conflict');
    if (task.status === 'terminal' || (task.status === 'submitted' && (runId === undefined || task.runId === runId))) return;
    this.replaceTask(goal, { ...task, status: 'submitted', submissionAccepted: true, ...(runId === undefined ? {} : { runId }) }, now);
  }
  public stage(goal: GoalExecutionRecord, attempt: number, input: { runId: string; effectId: string; idempotencyKey: string; decision: GoalDecision }, now: string): { staged: true; goalId: string; attempt: number } {
    const task = this.task(goal, attempt); const decision = goalDecisionSchema.parse(input.decision);
    const fingerprint = `sha256:${createHash('sha256').update(JSON.stringify(decision)).digest('hex')}`;
    const receipt = { staged: true as const, goalId: goal.goalId, attempt };
    if (task.decision !== undefined) {
      if (task.decision.idempotencyKey !== input.idempotencyKey || task.decision.runId !== input.runId
        || task.decision.effectId !== input.effectId || task.decision.fingerprint !== fingerprint) throw new Error('goal_decision_conflict');
      return receipt;
    }
    if (task.status === 'unclaimed' || task.status === 'terminal' || goal.status !== 'active'
      || !['planning', 'verifying'].includes(goal.agentExecution!.status) || Date.parse(goal.agentExecution!.deadlineAt) <= Date.parse(now)) {
      throw new Error('goal_decision_not_authorized');
    }
    if (task.runId !== undefined && task.runId !== input.runId) throw new Error('goal_planner_run_conflict');
    if (decision.decision === 'plan') assertTodoDependencies(decision.tasks.map(item => ({ todoId: item.key, dependsOn: item.dependsOn })));
    if (decision.decision === 'complete') this.assertCompletion(goal, task, decision);
    this.replaceTask(goal, { ...task, decision: { idempotencyKey: input.idempotencyKey, effectId: input.effectId,
      runId: input.runId, value: decision, fingerprint } }, now);
    return receipt;
  }
  public settle(goalId: string, attempt: number, outcome: 'completed' | 'failed' | 'cancelled', source: GoalPlannerResultSource | undefined, now: string): void {
    let goal = this.require(goalId); const task = this.task(goal, attempt);
    if (task.status === 'terminal') {
      if (task.outcome !== outcome || JSON.stringify(task.source) !== JSON.stringify(source)) throw new Error('goal_planner_result_conflict');
      return;
    }
    if (task.status === 'unclaimed' || (outcome === 'completed' && (source === undefined || task.submissionAccepted !== true))
      || (task.runId !== undefined && source === undefined)
      || (source !== undefined && (source.runId !== task.runId || source.message.sessionId !== task.sessionId))) throw new Error('goal_planner_result_conflict');
    const terminal = { ...task, status: 'terminal' as const, outcome, ...(source === undefined ? {} : { source }) };
    goal = this.save(this.withTask(goal, terminal), now);
    if (goal.agentExecution!.status === 'stopping') { this.finishStop(goal, now); return; }
    if (Date.parse(goal.agentExecution!.deadlineAt) <= Date.parse(now)) {
      const stopped = this.requestStop({ ...goal, agentExecution: { ...goal.agentExecution!,
        summary: '目标 deadline 已到，本次规划决定未应用。' } }, 'paused', now);
      this.finishStop(stopped, now); return;
    }
    if (goal.status !== 'active') { this.block(goal, '目标已暂停，规划结果未应用。', now); return; }
    if (outcome !== 'completed' || terminal.decision === undefined) { this.block(goal, '规划 Run 未完成有效决定，请查看任务会话并明确恢复。', now); return; }
    const decision = terminal.decision.value;
    if (decision.decision === 'blocked') { this.block(goal, decision.summary, now); return; }
    const todos = this.store.readTodos(goal.goalId);
    if ((todos?.revision ?? null) !== task.todoRevision) {
      this.block(goal, '规划期间待办已被修改，旧规划未应用；请检查当前待办后恢复。', now); return;
    }
    if (decision.decision === 'complete') {
      this.assertCompletion(goal, terminal, decision);
      this.save({ ...goal, status: 'complete', agentExecution: { ...goal.agentExecution!, status: 'complete', completedBy: 'verification', summary: decision.summary } }, now); return;
    }
    if (goal.roundsUsed >= goal.roundCap) { this.block(goal, '已达到目标执行轮次上限。', now); return; }
    const workflowId = goalExecutionId('workflow', goal, String(attempt));
    const ids = new Map(decision.tasks.map(item => [item.key, goalExecutionId('todo', goal, String(attempt), item.key)]));
    this.store.replaceTodos({ kind: 'todo.snapshot.replace', contractVersion: '5.0', workspaceId: goal.workspaceId, sessionId: goal.sessionId,
      goalId: goal.goalId, expectedGoalVersion: goal.version, expectedRevision: todos?.revision ?? null,
      items: decision.tasks.map(item => ({ todoId: ids.get(item.key)!, title: item.title, status: 'pending', dependsOn: item.dependsOn.map(key => ids.get(key)!) })) }, now);
    // The completed planner proof already precedes the existing Workflow owner's Goal version advance.
    this.store.startWorkflow({ kind: 'workflow.start', contractVersion: '5.0', workspaceId: goal.workspaceId, sessionId: goal.sessionId,
      goalId: goal.goalId, workflowId, expectedGoalVersion: goal.version, expectedTodoRevision: (this.store.readTodos(goal.goalId))!.revision,
      todoIds: [...ids.values()], maxConcurrency: goal.agentExecution!.maxConcurrency, maxTransitions: ids.size,
      executionMode: 'agent', deadlineAt: goal.agentExecution!.deadlineAt }, now, {
        sourceSessionId: terminal.source!.message.sessionId, sourceSessionVersion: terminal.source!.sessionVersion,
        boundary: terminal.source!.message
      });
    const advanced = this.require(goal.goalId);
    this.save({ ...advanced, agentExecution: { ...advanced.agentExecution!, status: 'executing', summary: decision.summary,
      workflowIds: [...advanced.agentExecution!.workflowIds, workflowId] } }, now);
  }
  public poll(goalId: string, now: string): void {
    let goal = this.require(goalId); const execution = goal.agentExecution!;
    if (['complete', 'paused', 'blocked'].includes(execution.status)) return;
    if (Date.parse(execution.deadlineAt) <= Date.parse(now) && execution.status !== 'stopping') {
      goal = this.save({ ...goal, status: 'paused', agentExecution: { ...execution, status: 'stopping', stopTarget: 'paused', summary: '目标 deadline 已到，等待实际任务结束。' } }, now);
      this.cancelWorkflow(goal, now);
    }
    if (goal.agentExecution!.status === 'stopping') { this.finishStop(goal, now); return; }
    if (execution.status !== 'executing') return;
    const workflow = this.latestWorkflow(goal);
    if (workflow === null || ['running', 'cancelling'].includes(workflow.status)) return;
    if (execution.tasks.length >= goal.roundCap * 2 + 1) { this.block(goal, '已达到规划尝试上限。', now); return; }
    this.save({ ...goal, agentExecution: { ...execution, status: 'verifying', tasks: [...execution.tasks, this.createTask(goal, 'verifying')] } }, now);
  }
  private assertCompletion(goal: GoalExecutionRecord, task: GoalPlannerTask, decision: Extract<GoalDecision, { decision: 'complete' }>): void {
    const workflow = this.latestWorkflow(goal);
    if (task.phase !== 'verifying' || workflow?.status !== 'completed'
      || decision.checks.length !== goal.agentExecution!.criteria.length || new Set(decision.checks.map(check => check.criterion)).size !== decision.checks.length
      || decision.checks.some(check => check.criterion >= goal.agentExecution!.criteria.length || check.status !== 'passed'
        || new Set(check.sources.map(source => JSON.stringify(source))).size !== check.sources.length
        || check.sources.some(source => source.kind === 'task_result'
          && !task.dependencyMessages?.some(item => item.reference.messageId === source.messageId)))) throw new Error('goal_completion_not_proven');
  }
  private createTask(goal: GoalExecutionRecord, phase: 'planning' | 'verifying'): GoalPlannerTask {
    const execution = goal.agentExecution!; const attempt = execution.tasks.length + 1;
    const workflow = this.latestWorkflow(goal); const todos = this.store.readTodos(goal.goalId);
    const context = phase === 'planning' ? todos?.items.map(item => ({ title: item.title, status: item.status })) ?? []
      : workflow?.results ?? [];
    const dependencyMessages = workflow?.agentExecution?.tasks.filter(task => task.resultMessage !== undefined)
      .map(task => ({ todoId: task.todoId, reference: task.resultMessage! })) ?? [];
    const snapshot = JSON.stringify(context); const criteria = execution.criteria.map((text, index) => `${index}: ${text}`).join('\n');
    const prefix = `目标：${goal.title}\n必须逐项满足的验收标准：\n${criteria}\n当前阶段：${phase}\n本轮执行快照：\n`;
    const instruction = '\n请检查实际工作区和前置结果。使用 productivity.record_goal_decision 提交一次结构化决定：下一轮任务依赖图、逐项通过的验收与证据，或明确受阻原因。complete 的每个 check 必须附 sources：task_result 的 messageId 必须来自下列前置结果，或 tool_result 的 toolCallId 必须是本 Run 已成功的工具调用。证据需解释实际产物如何满足该项标准；任务完成不等于验收通过。首次规划至少提出一个实际执行或验证任务。提交决定后报告依据并结束本次 Run。';
    const summaryBudget = Math.min(12_000, 100_000 - prefix.length - instruction.length - 32
      - productivityDependencyPromptOverhead(dependencyMessages.map(item => item.reference)) - dependencyMessages.length * 32);
    if (summaryBudget < 1) throw new Error('goal_dependency_context_too_large');
    const prompt = prefix + (snapshot.length > summaryBudget ? snapshot.slice(0, summaryBudget) + '【快照摘要已截断】' : snapshot) + instruction;
    return { attempt, phase, todoRevision: todos?.revision ?? null, todoId: goalExecutionId('planner', goal, String(attempt)), title: `${phase === 'planning' ? '目标规划' : '目标验收'}：${goal.title}`.slice(0, 2_000),
      prompt, status: 'unclaimed', sessionId: goalExecutionId('session', goal, String(attempt)),
      messageId: goalExecutionId('message', goal, String(attempt)), createCommandId: goalExecutionId('create', goal, String(attempt)),
      submitCommandId: goalExecutionId('submit', goal, String(attempt)), ...(dependencyMessages.length ? { dependencyMessages } : {}) };
  }
  private finishStop(goal: GoalExecutionRecord, now: string): void {
    const task = goal.agentExecution!.tasks.at(-1)!;
    const workflow = this.latestWorkflow(goal);
    if (workflow !== null && ['running', 'cancelling'].includes(workflow.status)) return;
    if (task.status !== 'terminal' && task.status !== 'unclaimed') return;
    const status = goal.agentExecution!.stopTarget ?? 'paused';
    const terminal = task.status === 'unclaimed' ? { ...task, status: 'terminal' as const } : task;
    this.save({ ...this.withTask(goal, terminal), status, agentExecution: { ...this.withTask(goal, terminal).agentExecution!, status,
      ...(status === 'complete' ? { completedBy: 'user' as const, summary: '用户标记完成，未进行自主验收。' } : {}) } }, now);
  }
  private cancelWorkflow(goal: GoalExecutionRecord, now: string): void {
    const workflow = this.latestWorkflow(goal);
    if (workflow === null || workflow.status !== 'running') return;
    this.store.cancelWorkflow({ kind: 'workflow.cancel', contractVersion: '5.0', workspaceId: goal.workspaceId,
      sessionId: goal.sessionId, workflowId: workflow.workflowId, expectedVersion: workflow.version }, now);
  }
  private latestWorkflow(goal: GoalExecutionRecord): WorkflowExecutionRecord | null {
    const id = goal.agentExecution?.workflowIds.at(-1);
    if (id === undefined) return null;
    const workflow = this.store.readWorkflow(id);
    if (workflow === null || workflow.goalId !== goal.goalId || workflow.agentExecution === undefined
      || JSON.stringify(workflow.agentExecution.criteria) !== JSON.stringify(goal.agentExecution!.criteria)) throw new Error('goal_workflow_authority_conflict');
    return workflow;
  }
  private block(goal: GoalExecutionRecord, summary: string, now: string): void {
    this.save({ ...goal, status: 'blocked', agentExecution: { ...goal.agentExecution!, status: 'blocked', summary: summary.slice(0, 4_000) } }, now);
  }
  private task(goal: GoalExecutionRecord, attempt: number): GoalPlannerTask {
    const task = goal.agentExecution?.tasks.find(item => item.attempt === attempt);
    if (task === undefined) throw new Error('goal_planner_attempt_conflict'); return task;
  }
  private require(id: string): GoalExecutionRecord {
    const goal = this.store.readGoal(id);
    if (goal?.agentExecution === undefined) throw new ProductivityCommandRejected('goal_autonomy_not_started'); return goal;
  }
  private withTask(goal: GoalExecutionRecord, task: GoalPlannerTask): GoalExecutionRecord {
    return { ...goal, agentExecution: { ...goal.agentExecution!, tasks: goal.agentExecution!.tasks.map(item => item.attempt === task.attempt ? task : item) } };
  }
  private replaceTask(goal: GoalExecutionRecord, task: GoalPlannerTask, now: string): void { this.save(this.withTask(goal, task), now); }
  private save(goal: GoalExecutionRecord, now: string): GoalExecutionRecord {
    const advanced = { ...goal, version: goal.version + 1, updatedAt: now };
    const stored = { ...advanced, autonomy: projectGoal(advanced).autonomy! };
    parseGoalExecutionRecord(stored); this.store.writeGoal(stored, now); return stored;
  }
}

function goalExecutionId(kind: string, goal: GoalExecutionRecord, ...parts: string[]): string {
  return workflowIdFor(`goal-${kind}`, goal.goalId, String(goal.agentExecution!.generation), ...parts);
}
