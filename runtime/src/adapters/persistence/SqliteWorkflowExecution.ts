import { readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conversationMessageReferenceSchema, publicProjectionCanonicalIdSchema, runtimeResultSchema,
  type ConversationMessageReference, type ProductivityResult } from '@ariadne/protocol/public';
import { z } from 'zod';
import type { FrozenConversationContext } from './conversation/SqliteConversationNavigationStore.js';
import { assertTodoDependencies, readyWorkflowTodoIds } from './WorkflowDependencies.js';

type PublicWorkflow = Extract<ProductivityResult, { kind: 'workflow.updated' }>['workflow'];
type TodoStatus = Extract<ProductivityResult, { kind: 'todo.snapshot.replaced' }>['items'][number]['status'];
export interface WorkflowAgentTask {
  readonly todoId: string;
  readonly title: string;
  readonly prompt: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly createCommandId: string;
  readonly submitCommandId: string;
  readonly status: 'unclaimed' | 'claimed' | 'submitted' | 'terminal';
  readonly runId?: string;
  readonly resultRunVersion?: number;
  readonly submissionAccepted?: true;
  readonly dependencyMessages?: readonly { readonly todoId: string; readonly reference: ConversationMessageReference }[];
  readonly resultMessage?: ConversationMessageReference;
}
export interface WorkflowTaskResultSource {
  readonly runId: string;
  readonly runVersion: number;
  readonly resultMessage?: ConversationMessageReference;
}
export interface WorkflowExecutionRecord extends PublicWorkflow {
  readonly agentExecution?: {
    readonly tasks: readonly WorkflowAgentTask[];
    readonly context?: FrozenConversationContext;
    readonly criteria?: readonly string[];
    readonly stop?: { readonly outcome: 'failed' | 'cancelled'; readonly reason: string };
  };
}
export interface WorkflowAgentWork {
  readonly workflow: WorkflowExecutionRecord;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly goalStatus: string;
}
type Writer = (workflow: WorkflowExecutionRecord, workspaceId: string, sessionId: string, now: string) => void;
type TodoWriter = (goalId: string, states: ReadonlyMap<string, TodoStatus>, now: string) => void;
const executionSchema = z.object({
  criteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(32).optional(),
  context: z.object({ sourceSessionId: publicProjectionCanonicalIdSchema,
    sourceSessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    boundary: conversationMessageReferenceSchema.optional()
  }).strict().refine(context => context.boundary === undefined || context.boundary.sessionId === context.sourceSessionId).optional(),
  tasks: z.array(z.object({
    todoId: publicProjectionCanonicalIdSchema, title: z.string().trim().min(1).max(2_000),
    prompt: z.string().min(1).max(100_000), sessionId: publicProjectionCanonicalIdSchema,
    messageId: publicProjectionCanonicalIdSchema, createCommandId: publicProjectionCanonicalIdSchema,
    submitCommandId: publicProjectionCanonicalIdSchema, status: z.enum(['unclaimed', 'claimed', 'submitted', 'terminal']),
    runId: publicProjectionCanonicalIdSchema.optional(), resultRunVersion: z.number().int().positive().optional(),
    submissionAccepted: z.literal(true).optional(), resultMessage: conversationMessageReferenceSchema.optional(),
    dependencyMessages: z.array(z.object({ todoId: publicProjectionCanonicalIdSchema,
      reference: conversationMessageReferenceSchema }).strict()).max(256).optional()
  }).strict()).min(1).max(256),
  stop: z.object({ outcome: z.enum(['failed', 'cancelled']), reason: z.string().min(1).max(128) }).strict().optional()
}).strict();

export function parseWorkflowExecutionRecord(value: unknown): WorkflowExecutionRecord {
  const record = value as WorkflowExecutionRecord;
  if (record === null || typeof record !== 'object') throw new Error('workflow_execution_authority_invalid');
  const { agentExecution, ...publicPart } = record;
  if (!runtimeResultSchema.safeParse({ kind: 'workflow.updated', workflow: publicPart }).success
    || ((record.executionMode === 'agent') !== (agentExecution !== undefined))) throw new Error('workflow_execution_authority_invalid');
  if (record.dependencies !== undefined) {
    const known = [...record.activeTodoIds, ...record.pendingTodoIds, ...record.results.map(item => item.todoId)];
    try { assertTodoDependencies(record.dependencies); } catch { throw new Error('workflow_execution_authority_invalid'); }
    if (record.dependencies.length !== known.length || record.dependencies.some(node => !known.includes(node.todoId))
      || readyWorkflowTodoIds({ ...record, pendingTodoIds: record.activeTodoIds }, record.maxConcurrency).length !== record.activeTodoIds.length) {
      throw new Error('workflow_execution_authority_invalid');
    }
  }
  if (agentExecution === undefined) return record;
  if (!executionSchema.safeParse(agentExecution).success) throw new Error('workflow_execution_authority_invalid');
  const known = [...record.activeTodoIds, ...record.pendingTodoIds, ...record.results.map(item => item.todoId)];
  const tasks = agentExecution.tasks;
  if (new Set(known).size !== known.length || known.length !== tasks.length
    || new Set(tasks.map(task => task.todoId)).size !== tasks.length
    || tasks.some(task => !known.includes(task.todoId)
      || task.sessionId !== workflowIdFor('session', record.workflowId, task.todoId)
      || task.messageId !== workflowIdFor('message', record.workflowId, task.todoId)
      || task.createCommandId !== workflowIdFor('create', record.workflowId, task.todoId)
      || task.submitCommandId !== workflowIdFor('submit', record.workflowId, task.todoId)
      || ((task.status === 'terminal') !== record.results.some(item => item.todoId === task.todoId))
      || (task.status === 'submitted' && task.submissionAccepted !== true)
      || (task.runId !== undefined && task.submissionAccepted !== true)
      || (task.resultRunVersion !== undefined && (task.runId === undefined || task.status !== 'terminal'))
      || (task.resultMessage !== undefined && (task.resultRunVersion === undefined || task.resultMessage.sessionId !== task.sessionId))
      || !validDependencyMessages(record, task))
    || (record.status === 'running' && agentExecution.stop !== undefined)
    || (record.status === 'cancelling' && agentExecution.stop === undefined)
    || (!['running', 'cancelling'].includes(record.status) && tasks.some(task => task.status !== 'terminal'))) {
    throw new Error('workflow_execution_authority_invalid');
  }
  return record;
}

export function createWorkflowAgentExecution(
  workflowId: string, goalTitle: string,
  todos: readonly { todoId: string; title: string; priorCompletedDependencies?: readonly { todoId: string; title: string }[] }[],
  context?: FrozenConversationContext, goalCriteria?: readonly string[]
): NonNullable<WorkflowExecutionRecord['agentExecution']> {
  return { ...(context === undefined ? {} : { context }), ...(goalCriteria === undefined ? {} : { criteria: [...goalCriteria] }), tasks: todos.map(todo => ({
    todoId: todo.todoId, title: todo.title,
    prompt: `目标：${goalTitle}\n当前待办：${todo.title}\n请完成当前待办，检查结果，并报告实际完成内容及未解决的问题。`
      + (todo.priorCompletedDependencies?.length ? `\n以下前置待办在启动快照中已被标记完成；没有本轮 Agent 结果引用，请验证所需产物（长标题为摘要）：\n${JSON.stringify(todo.priorCompletedDependencies.map(item => item.title.length > 40 ? item.title.slice(0, 40) + '…' : item.title))}` : ''),
    sessionId: workflowIdFor('session', workflowId, todo.todoId),
    messageId: workflowIdFor('message', workflowId, todo.todoId),
    createCommandId: workflowIdFor('create', workflowId, todo.todoId),
    submitCommandId: workflowIdFor('submit', workflowId, todo.todoId), status: 'unclaimed'
  })) };
}

export function projectWorkflow(record: WorkflowExecutionRecord): PublicWorkflow {
  parseWorkflowExecutionRecord(record);
  const { agentExecution, ...workflow } = record;
  return agentExecution === undefined ? workflow : {
    ...workflow, executionMode: 'agent', taskRuns: agentExecution.tasks
      .filter(task => task.submissionAccepted === true)
      .map(task => ({ todoId: task.todoId, sessionId: task.sessionId, runId: task.runId ?? null }))
  };
}

/** Durable task intents share the Workflow transaction; no second execution ledger or host authority. */
export class SqliteWorkflowExecution {
  public constructor(private readonly database: DatabaseSync, private readonly write: Writer, private readonly todos: TodoWriter) {}

  public pending(): readonly WorkflowAgentWork[] {
    const rows = this.database.prepare(
      `SELECT w.workflow_json,w.workspace_id,w.session_id,g.status AS goal_status
       FROM productivity_workflows w JOIN productivity_goals g ON g.goal_id=w.goal_id
       WHERE w.status IN ('running','cancelling') ORDER BY w.updated_at,w.workflow_id`
    ).all() as unknown as { workflow_json: string; workspace_id: string; session_id: string; goal_status: string }[];
    return rows.flatMap(row => {
      const workflow = readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
      return workflow.agentExecution === undefined ? [] : [{ workflow, workspaceId: row.workspace_id,
        sessionId: row.session_id, goalStatus: row.goal_status }];
    });
  }

  public claim(workflowId: string, todoId: string, now: string): WorkflowAgentTask | null {
    const work = this.require(workflowId);
    const current = work.workflow;
    const task = current.agentExecution!.tasks.find(item => item.todoId === todoId);
    if (task === undefined) throw new Error('workflow_task_not_found');
    if (task.status !== 'unclaimed') return task.status === 'terminal' ? null : task;
    if (current.status !== 'running' || work.goalStatus !== 'active'
      || Date.parse(current.deadlineAt) <= Date.parse(now) || !current.activeTodoIds.includes(todoId)) return null;
    const dependencies = current.dependencies?.find(node => node.todoId === todoId)?.dependsOn ?? [];
    const dependencyMessages = dependencies.map(id => {
      const predecessor = current.agentExecution!.tasks.find(item => item.todoId === id);
      if (predecessor?.status !== 'terminal' || predecessor.resultMessage === undefined
        || !current.results.some(result => result.todoId === id && result.outcome === 'completed')) {
        throw new Error('workflow_dependency_result_missing');
      }
      return { todoId: id, reference: predecessor.resultMessage };
    });
    const claimed = { ...task, status: 'claimed' as const, ...(dependencyMessages.length ? { dependencyMessages } : {}) };
    this.replaceTask(work, claimed, now);
    return claimed;
  }

  public submitted(workflowId: string, todoId: string, runId: string | undefined, now: string): void {
    const work = this.require(workflowId);
    const task = work.workflow.agentExecution!.tasks.find(item => item.todoId === todoId);
    if (task === undefined || task.status === 'unclaimed') throw new Error('workflow_task_not_claimed');
    if (task.runId !== undefined && runId !== undefined && task.runId !== runId) throw new Error('workflow_task_run_conflict');
    if (task.status === 'terminal' || (task.status === 'submitted' && (runId === undefined || task.runId === runId))) return;
    this.replaceTask(work, { ...task, status: 'submitted', submissionAccepted: true,
      ...(runId === undefined ? {} : { runId }) }, now);
  }

  public settle(workflowId: string, todoId: string, outcome: 'completed' | 'failed' | 'cancelled', summary: string, now: string,
    source?: WorkflowTaskResultSource): void {
    const work = this.require(workflowId);
    let current = work.workflow;
    const task = current.agentExecution!.tasks.find(item => item.todoId === todoId);
    if (task === undefined || task.status === 'unclaimed') throw new Error('workflow_task_not_claimed');
    if (source !== undefined && (task.runId !== source.runId || !Number.isSafeInteger(source.runVersion) || source.runVersion < 1)) {
      throw new Error('workflow_task_result_source_conflict');
    }
    if (task.runId !== undefined && source === undefined) throw new Error('workflow_task_result_source_required');
    if (source?.resultMessage !== undefined && (!conversationMessageReferenceSchema.safeParse(source.resultMessage).success
      || source.resultMessage.sessionId !== task.sessionId || outcome !== 'completed')) throw new Error('workflow_task_result_source_conflict');
    if (outcome === 'completed' && current.dependencies?.some(node => node.dependsOn.includes(todoId))
      && source?.resultMessage === undefined) throw new Error('workflow_dependency_result_missing');
    if (task.status === 'terminal') {
      const result = current.results.find(item => item.todoId === todoId);
      if (result?.outcome !== outcome || result.summary !== summary.slice(0, 4_000)
        || task.resultRunVersion !== source?.runVersion
        || JSON.stringify(task.resultMessage) !== JSON.stringify(source?.resultMessage)) throw new Error('workflow_task_result_conflict');
      return;
    }
    if (!current.activeTodoIds.includes(todoId)) throw new Error('workflow_task_not_active');
    const transitionsUsed = current.transitionsUsed + 1;
    if (transitionsUsed > current.maxTransitions) throw new Error('workflow_budget_exceeded');
    current = { ...current, version: current.version + 1, transitionsUsed,
      activeTodoIds: current.activeTodoIds.filter(id => id !== todoId),
      results: [...current.results, { todoId, outcome, summary: summary.slice(0, 4_000) }],
      agentExecution: { ...current.agentExecution!, tasks: current.agentExecution!.tasks
        .map(item => item.todoId === todoId ? { ...item, status: 'terminal' as const,
          ...(source === undefined ? {} : { resultRunVersion: source.runVersion,
            ...(source.resultMessage === undefined ? {} : { resultMessage: source.resultMessage }) }) } : item) }
    };
    this.todos(current.goalId, new Map([[todoId, outcome]]), now);
    if (current.agentExecution!.stop === undefined && outcome !== 'completed') {
      current = this.requestStop({ ...work, workflow: current }, 'failed', 'workflow_task_failed', now);
    } else if (current.agentExecution!.stop === undefined && Date.parse(current.deadlineAt) <= Date.parse(now)) {
      current = this.requestStop({ ...work, workflow: current }, 'failed', 'workflow_deadline_exceeded', now);
    } else {
      if (current.agentExecution!.stop === undefined) {
        const activated = readyWorkflowTodoIds(current, current.maxConcurrency - current.activeTodoIds.length);
        current = { ...current, activeTodoIds: [...current.activeTodoIds, ...activated],
          pendingTodoIds: current.pendingTodoIds.filter(id => !activated.includes(id)) };
        this.todos(current.goalId, new Map(activated.map(id => [id, 'in_progress'])), now);
      }
      current = this.finishIfQuiescent(current);
      this.write(current, work.workspaceId, work.sessionId, now);
    }
  }

  /** Only unclaimed tasks can be withdrawn immediately. Claimed work must settle its actual Run. */
  public requestStop(work: WorkflowAgentWork, outcome: 'failed' | 'cancelled', reason: string, now: string): WorkflowExecutionRecord {
    const current = work.workflow;
    if (current.agentExecution === undefined) throw new Error('workflow_execution_unavailable');
    if (current.agentExecution.stop !== undefined) return current;
    const withdrawn = current.agentExecution.tasks.filter(task => task.status === 'unclaimed');
    const ids = new Set(withdrawn.map(task => task.todoId));
    const workflow = this.finishIfQuiescent({
      ...current, version: current.version + 1, status: 'cancelling', pendingTodoIds: [],
      activeTodoIds: current.activeTodoIds.filter(id => !ids.has(id)),
      results: [...current.results, ...withdrawn.map(task => ({ todoId: task.todoId, outcome: 'cancelled' as const, summary: reason }))],
      agentExecution: { ...current.agentExecution, tasks: current.agentExecution.tasks.map(task => ids.has(task.todoId)
        ? { ...task, status: 'terminal' as const } : task), stop: { outcome, reason } }
    });
    this.todos(current.goalId, new Map([...ids].map(id => [id, 'cancelled'])), now);
    this.write(workflow, work.workspaceId, work.sessionId, now);
    return workflow;
  }

  private require(workflowId: string): WorkflowAgentWork {
    const row = this.database.prepare(
      `SELECT w.workflow_json,w.workspace_id,w.session_id,g.status AS goal_status
       FROM productivity_workflows w JOIN productivity_goals g ON g.goal_id=w.goal_id WHERE w.workflow_id=?`
    ).get(workflowId) as { workflow_json: string; workspace_id: string; session_id: string; goal_status: string } | undefined;
    if (row === undefined) throw new Error('workflow_not_found');
    const workflow = readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
    if (workflow.agentExecution === undefined) throw new Error('workflow_execution_unavailable');
    return { workflow, workspaceId: row.workspace_id, sessionId: row.session_id, goalStatus: row.goal_status };
  }
  private replaceTask(work: WorkflowAgentWork, task: WorkflowAgentTask, now: string): void {
    this.write({ ...work.workflow, version: work.workflow.version + 1,
      agentExecution: { ...work.workflow.agentExecution!, tasks: work.workflow.agentExecution!.tasks
        .map(item => item.todoId === task.todoId ? task : item) }
    }, work.workspaceId, work.sessionId, now);
  }
  private finishIfQuiescent(workflow: WorkflowExecutionRecord): WorkflowExecutionRecord {
    if (workflow.activeTodoIds.length > 0 || workflow.pendingTodoIds.length > 0) return workflow;
    if (workflow.agentExecution!.tasks.some(task => task.status !== 'terminal')) throw new Error('workflow_quiescence_not_proven');
    return { ...workflow, status: workflow.agentExecution!.stop?.outcome ?? 'completed' };
  }
}

export function workflowIdFor(kind: string, ...parts: readonly string[]): string {
  return `id-${createHash('sha256').update(['workflow', kind, ...parts].join('\0')).digest('hex').slice(0, 48)}`;
}

function validDependencyMessages(record: WorkflowExecutionRecord, task: WorkflowAgentTask): boolean {
  const dependencies = record.dependencies?.find(node => node.todoId === task.todoId)?.dependsOn ?? [];
  if (task.status === 'unclaimed') return task.dependencyMessages === undefined;
  // Unclaimed tasks can be withdrawn without ever consuming their dependencies.
  if (task.status === 'terminal' && task.submissionAccepted !== true && task.dependencyMessages === undefined) return true;
  const references = task.dependencyMessages ?? [];
  return references.length === dependencies.length && new Set(references.map(item => item.todoId)).size === references.length
    && references.every(item => dependencies.includes(item.todoId)
      && JSON.stringify(item.reference) === JSON.stringify(record.agentExecution!.tasks.find(node => node.todoId === item.todoId)?.resultMessage));
}
