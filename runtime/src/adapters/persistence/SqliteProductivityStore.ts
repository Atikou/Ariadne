import { ProductivityCommandRejected } from './ProductivityCommandRejected.js';
import { readPersistedAuthorityJson } from './SqliteAuthorityHealth.js';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Cron } from 'croner';

import { runtimeResultSchema, type ProductivityCommand, type ProductivityResult } from '@ariadne/protocol/public';
import type { ProductivityAuthority } from '../../control/ports/ProductivityAuthority.js';
import type { ProductivityTaskCatalogReadV1, ProductivityTaskReadScope, ProductivityTaskReference } from '../../control/ports/ProductivityTaskCatalogReadV1.js';
import { SqliteProductivityTaskCatalogRead } from './SqliteProductivityTaskCatalogRead.js';
import type { ProductivityTaskIsolationV1, ProductivityTaskKind, ProductivityTaskFaultCode, ProductivityTaskRecoveryClaimV1 } from '../../control/ports/ProductivityTaskIsolationV1.js';
import { SqliteProductivityTaskIsolation } from './SqliteProductivityTaskIsolation.js';
import { SqliteProductivityTaskRecovery } from './SqliteProductivityTaskRecovery.js';
import type { ProductivityTaskRecoveryCommand } from '@ariadne/protocol/public';
import type { ProductivityTaskRecoveryAuthorityV1 } from '../../control/ports/ProductivityTaskRecoveryAuthorityV1.js';
import type { ProductivityTaskRecoveryQueryV1 } from '../../control/ports/ProductivityTaskRecoveryQueryV1.js';
import { withWorkflowTaskCriteria } from '../../conversation/ProductivityTaskPrompt.js';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { SqliteTransactionOwner, type SqliteTransactionShutdownContext } from './SqliteTransactionOwner.js';
import { queryScheduleOccurrences, retryScheduleOccurrence, pendingScheduleOccurrences, claimScheduleOccurrence,
  settleScheduleOccurrence, recoverExpiredScheduleClaims, claimedScheduleOccurrences, type ScheduledSubmissionIdentity } from './SqliteScheduleOccurrences.js';
import { initializeProductivitySchema } from './ProductivityDbSchema.js';
import { DATABASE_PATHS } from './DatabasePaths.js';
import { commandReceiptIdentity } from './CommandReceiptIdentity.js';
import { readPersistedRuntimeResult } from '@ariadne/protocol/compatibility';
export { PRODUCTIVITY_DB_SCHEMA_VERSION } from './ProductivityDbSchema.js';
export { SCHEDULE_SUBMISSION_MAX_ATTEMPTS } from './ScheduleSubmissionPolicy.js';
import { createWorkflowAgentExecution, parseWorkflowExecutionRecord, projectWorkflow, SqliteWorkflowExecution,
  type WorkflowAgentTask, type WorkflowAgentWork, type WorkflowExecutionRecord, type WorkflowTaskResultSource } from './SqliteWorkflowExecution.js';
import type { FrozenConversationContext } from './conversation/SqliteConversationNavigationStore.js';
import { assertTodoDependencies, readyWorkflowTodoIds, workflowDependenciesForSelection } from './WorkflowDependencies.js';
import { parseGoalExecutionRecord, projectGoal, SqliteGoalAutonomy, type GoalExecutionRecord, type GoalPlannerTask } from './SqliteGoalAutonomy.js';
import type { GoalDecision, GoalPlannerResultSource } from '../../control/ports/GoalPlanningAuthority.js';


type Goal = GoalExecutionRecord;
type Todo = Extract<ProductivityResult, { kind: 'todo.snapshot.replaced' }>['items'][number];
type Workflow = WorkflowExecutionRecord;
type Schedule = Extract<ProductivityResult, { kind: 'schedule.updated' }>['schedule'];

interface GoalRow { goal_json: string }
interface TodoRow { revision: number; items_json: string }
interface WorkflowRow { workflow_json: string }
interface ScheduleRow { schedule_json: string }
interface CommandRow { fingerprint: string; result_json: string }
export type DueScheduleOccurrence = ScheduledSubmissionIdentity;

/** Versioned Goal/Todo/Workflow/Schedule authority; it executes no host code. */
export class SqliteProductivityStore implements ProductivityAuthority, ProductivityTaskIsolationV1, ProductivityTaskRecoveryAuthorityV1, ProductivityTaskRecoveryQueryV1, ProductivityTaskCatalogReadV1 {
  private readonly database: DatabaseSync;
  private readonly owner: SqliteTransactionOwner;
  private readonly workflowExecution: SqliteWorkflowExecution;
  private readonly goalAutonomy: SqliteGoalAutonomy;
  private readonly taskIsolation: SqliteProductivityTaskIsolation;
  private readonly taskRecovery: SqliteProductivityTaskRecovery;

  public assertHealthy(): void { this.owner.assertHealthy(); }

  public readTaskCatalogPage(scope: ProductivityTaskReadScope, after: ProductivityTaskReference | null, limit: number) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return new SqliteProductivityTaskCatalogRead(this.database).readPage(scope, after, limit);
    }, signal));
  }
  public readTaskCatalogItem(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return new SqliteProductivityTaskCatalogRead(this.database).readItem(scope, reference);
    }, signal));
  }
  public readTaskRelations(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference,
    expected: Parameters<ProductivityTaskCatalogReadV1['readTaskRelations']>[2], afterIndex: number, limit: number) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return new SqliteProductivityTaskCatalogRead(this.database).readRelations(scope, reference, expected, afterIndex, limit);
    }, signal));
  }

  public constructor(dataRoot: string) {
    const databasePath = path.resolve(dataRoot, DATABASE_PATHS.productivity);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const lease = acquireSqliteOwnerLease(databasePath, 'productivity');
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
      initializeProductivitySchema(database, lease);
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.database = database;
      this.taskIsolation = new SqliteProductivityTaskIsolation(database);
      this.taskRecovery = new SqliteProductivityTaskRecovery(database, this.taskIsolation, claim => this.taskRecoverySubject(claim));
      this.workflowExecution = new SqliteWorkflowExecution(database,
        (workflow, workspaceId, sessionId, now) => this.writeWorkflow(workflow, workspaceId, sessionId, now),
        (goalId, states, now) => this.updateTodoStates(goalId, states, now));
      this.goalAutonomy = new SqliteGoalAutonomy({
        readGoal: id => this.readGoal(id), writeGoal: (goal, now) => this.writeGoal(goal, now),
        readTodos: id => this.readTodos(id), readWorkflow: id => this.readWorkflow(id),
        replaceTodos: (command, now) => { this.replaceTodos(command, now); },
        startWorkflow: (command, now, context) => { this.startWorkflow(command, now, context, true); },
        cancelWorkflow: (command, now) => { this.cancelWorkflow(command, now); }
      });
      this.owner = new SqliteTransactionOwner(database, databasePath, lease, {
        source: 'productivity',
        shutdownRequestedCode: 'productivity_shutdown_requested',
        closedCode: 'productivity_store_closed',
        shutdownConflictCode: 'productivity_shutdown_context_conflict',
        transactionActiveCode: 'productivity_transaction_already_active',
        shutdownDeadlineCode: 'productivity_shutdown_deadline_exceeded'
      });
    } catch (error) {
      if (database === null) lease.close();
      else try { closeOwnedSqliteDatabase(database, lease); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'productivity_open_and_cleanup_failed'); }
      throw error;
    }
  }

  public quarantineTask(kind: ProductivityTaskKind, entityId: string, taskId: string, code: ProductivityTaskFaultCode, now = new Date()) {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted(); return this.taskIsolation.quarantine(kind, entityId, taskId, code, now);
    }, signal));
  }
  public isTaskQuarantined(kind: ProductivityTaskKind, entityId: string, taskId: string) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return this.taskIsolation.isQuarantined(kind, entityId, taskId);
    }, signal));
  }
  public queryTaskFaults(workspaceId: string, sessionId: string, limit: number, afterFaultId?: string) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return this.taskIsolation.query(workspaceId, sessionId, limit, afterFaultId);
    }, signal));
  }
  public countQuarantinedTasks(kind: ProductivityTaskKind): Promise<number> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      return Number(this.database.prepare("SELECT count(*) AS count FROM productivity_task_faults WHERE task_kind=? AND state<>'resolved'").get(kind)!.count);
    }, signal));
  }
  private taskRecoverySubject(claim: NonNullable<ReturnType<SqliteProductivityTaskIsolation['readRecoveryClaim']>>): ProductivityTaskRecoveryClaimV1 {
      const { identity } = claim;
      const base = { fault: claim.fault, sourceDigest: claim.sourceDigest,
        messageId: identity.message_id, submitCommandId: identity.submit_command_id };
      if (identity.task_kind === 'schedule') {
        const row = this.database.prepare('SELECT prompt FROM productivity_schedule_occurrences WHERE occurrence_id=?').get(identity.task_id)!;
        return { ...base, prompt: String(row.prompt),
          ...(['submitted','failed','cancelled'].includes(identity.source_status) ? { terminal: {
            kind: 'submission' as const, status: identity.source_status as 'submitted' | 'failed' | 'cancelled' } } : {}) };
      }
      const record = identity.task_kind === 'workflow' ? this.readWorkflow(identity.entity_id)! : this.readGoal(identity.entity_id)!;
      const original = record.agentExecution!.tasks.find(task => task.todoId === identity.task_id)!;
      const task = identity.task_kind === 'workflow' ? withWorkflowTaskCriteria(original, record.agentExecution!.criteria) : original;
      const outcome = 'results' in record ? record.results.find(result => result.todoId === identity.task_id)?.outcome
        : (original as GoalPlannerTask).outcome;
      const plannerSource = identity.task_kind === 'goal' ? (original as GoalPlannerTask).source : undefined;
      const resultVersion = task.resultRunVersion ?? plannerSource?.runVersion, resultMessage = task.resultMessage ?? plannerSource?.message;
      const terminal: ProductivityTaskRecoveryClaimV1['terminal'] = task.status !== 'terminal' ? undefined : {
        kind: 'execution', status: outcome === 'completed' || outcome === 'cancelled' || outcome === 'failed' ? outcome : 'unknown',
        ...(resultVersion === undefined ? {} : { runVersion: resultVersion }),
        ...(resultMessage === undefined ? {} : { resultMessage }) };
      return { ...base, createCommandId: identity.create_command_id!, title: task.title, prompt: task.prompt,
        ...(terminal === undefined ? {} : { terminal }),
        ...(record.agentExecution!.context === undefined ? {} : { context: record.agentExecution!.context }),
        ...(task.runId === undefined ? {} : { runId: task.runId }),
        ...(task.dependencyMessages === undefined ? {} : { dependencyMessages: task.dependencyMessages }) };
  }
  public beginTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand, now = new Date()) {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted(); return this.taskRecovery.begin(commandId, request, now);
    }, signal));
  }
  public finishTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand,
    claim: ProductivityTaskRecoveryClaimV1, verified: boolean, now = new Date()) {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted(); return this.taskRecovery.finish(commandId, request, claim, verified, now);
    }, signal));
  }
  public readTaskRecoveryCommand(commandId: string, request: ProductivityTaskRecoveryCommand) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return this.taskRecovery.read(commandId, request);
    }, signal));
  }
  public queryTaskRecoveryClaims(workspaceId: string, ownerSessionId: string, claims: readonly { readonly faultId: string; readonly revision: number }[]) {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return this.taskRecovery.pending(workspaceId, ownerSessionId, claims);
    }, signal));
  }

  public execute(
    commandId: string,
    command: Exclude<ProductivityCommand, { kind: 'productivity.query' | 'schedules.query' | 'schedule.occurrences.query' }>,
    now = new Date(),
    workflowContext?: FrozenConversationContext
  ): Promise<ProductivityResult> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      const { fingerprint, previousFingerprints } = commandReceiptIdentity(command);
      const replay = this.database.prepare(
        'SELECT fingerprint, result_json FROM productivity_commands WHERE command_id=?'
      ).get(commandId) as CommandRow | undefined;
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint && !previousFingerprints.includes(replay.fingerprint)) throw new ProductivityCommandRejected('productivity_command_conflict');
        return readPersistedAuthorityJson('productivity', replay.result_json, readPersistedRuntimeResult) as ProductivityResult;
      }
      const occurredAt = canonicalDate(now);
      const result = this.apply(command, occurredAt, workflowContext);
      this.database.prepare(
        'INSERT INTO productivity_commands(command_id,fingerprint,result_json,committed_at) VALUES(?,?,?,?)'
      ).run(commandId, fingerprint, JSON.stringify(result), occurredAt);
      this.database.prepare(
        'INSERT INTO productivity_events(command_id,kind,event_json,occurred_at) VALUES(?,?,?,?)'
      ).run(commandId, command.kind, JSON.stringify(result), occurredAt);
      return result;
    }, signal));
  }

  public reconcile(
    commandId: string,
    command: Exclude<ProductivityCommand, { kind: 'productivity.query' | 'schedules.query' | 'schedule.occurrences.query' }>
  ): Promise<ProductivityResult | null> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const replay = this.database.prepare(
        'SELECT fingerprint, result_json FROM productivity_commands WHERE command_id=?'
      ).get(commandId) as CommandRow | undefined;
      if (replay === undefined) return null;
      const identity = commandReceiptIdentity(command);
      if (replay.fingerprint !== identity.fingerprint && !identity.previousFingerprints.includes(replay.fingerprint)) throw new ProductivityCommandRejected('productivity_command_conflict');
      return readPersistedAuthorityJson('productivity', replay.result_json, readPersistedRuntimeResult) as ProductivityResult;
    }, signal));
  }

  public query(workspaceId: string, sessionId: string): Promise<Extract<
    ProductivityResult, { kind: 'productivity.query_result' }
  >> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const goal = this.readGoalForSession(workspaceId, sessionId);
      const todos = goal === null ? null : this.readTodos(goal.goalId);
      const workflows = this.database.prepare(
        'SELECT workflow_json FROM productivity_workflows WHERE workspace_id=? AND session_id=? ORDER BY updated_at,workflow_id'
      ).all(workspaceId, sessionId) as unknown as WorkflowRow[];
      return {
        kind: 'productivity.query_result',
        goal: goal === null ? null : projectGoal(goal),
        todoRevision: todos?.revision ?? null,
        todos: todos?.items ?? [],
        workflows: workflows.map((row) => projectWorkflow(readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord)))
      };
    }, signal));
  }

  public querySchedules(workspaceId: string, sessionId: string): Promise<Extract<
    ProductivityResult, { kind: 'schedules.query_result' }
  >> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const rows = this.database.prepare(
        'SELECT schedule_json FROM productivity_schedules WHERE workspace_id=? AND session_id=? ORDER BY created_at,schedule_id'
      ).all(workspaceId, sessionId) as unknown as ScheduleRow[];
      return { kind: 'schedules.query_result', schedules: rows.map(parseSchedule) };
    }, signal));
  }

  public queryOccurrences(command: Extract<ProductivityCommand, { kind: 'schedule.occurrences.query' }>): Promise<Extract<
    ProductivityResult, { kind: 'schedule.occurrences.query_result' }
  >> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      return queryScheduleOccurrences(this.database, command);
    }, signal));
  }

  /** Private submission identity is read only for the same authorized public occurrence owner. */
  public readOccurrenceIdentity(occurrenceId: string, workspaceId: string, sessionId: string): Promise<DueScheduleOccurrence | null> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const row = this.database.prepare(`SELECT schedule_id,prompt,due_at,command_id,message_id,attempts
        FROM productivity_schedule_occurrences WHERE occurrence_id=? AND workspace_id=? AND session_id=?`)
        .get(occurrenceId, workspaceId, sessionId) as { schedule_id: string; prompt: string; due_at: string; command_id: string; message_id: string; attempts: number } | undefined;
      return row === undefined ? null : { occurrenceId, workspaceId, sessionId, scheduleId: row.schedule_id, prompt: row.prompt,
        dueAt: row.due_at, commandId: row.command_id, messageId: row.message_id, attempts: row.attempts };
    }, signal));
  }

  public materializeDue(now = new Date()): Promise<void> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      const nowIso = canonicalDate(now);
      recoverExpiredScheduleClaims(this.database, nowIso);
      const expired = this.database.prepare(
        `SELECT workflow_json,workspace_id,session_id FROM productivity_workflows WHERE status='running'`
      ).all() as unknown as (WorkflowRow & { workspace_id: string; session_id: string })[];
      for (const row of expired) {
        const workflow = readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
        if (Date.parse(workflow.deadlineAt) <= now.getTime()) {
          this.terminalizeExpired(workflow, row.workspace_id, row.session_id, nowIso);
        }
      }
      const rows = this.database.prepare(
        `SELECT schedule_json FROM productivity_schedules
         WHERE status='active' AND next_fire_at IS NOT NULL AND julianday(next_fire_at)<=julianday(?)
         ORDER BY julianday(next_fire_at),schedule_id LIMIT 64`
      ).all(nowIso) as unknown as ScheduleRow[];
      for (const row of rows) {
        signal.throwIfAborted();
        const schedule = parseSchedule(row);
        if (schedule.nextFireAt === null) continue;
        const occurrenceId = stableId('schedule-occurrence', schedule.scheduleId, schedule.nextFireAt);
        this.database.prepare(
          `INSERT OR IGNORE INTO productivity_schedule_occurrences(
             occurrence_id,schedule_id,workspace_id,session_id,prompt,due_at,command_id,message_id,status,attempts
           ) VALUES(?,?,?,?,?,?,?,?, 'pending',0)`
        ).run(
          occurrenceId, schedule.scheduleId, schedule.workspaceId, schedule.sessionId,
          schedule.prompt, schedule.nextFireAt,
          stableId('schedule-command', occurrenceId), stableId('schedule-message', occurrenceId)
        );
        const next = nextSchedule(schedule, now);
        this.writeSchedule(next, nowIso);
      }
    }, signal));
  }

  public pendingOccurrences(limit = 16, now = new Date(Date.now())): Promise<readonly DueScheduleOccurrence[]> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      return pendingScheduleOccurrences(this.database, limit, canonicalDate(now));
    }, signal));
  }

  public claimedOccurrences(): Promise<readonly DueScheduleOccurrence[]> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return claimedScheduleOccurrences(this.database);
    }, signal));
  }

  /** The durable submission boundary: cancellation only withdraws unclaimed occurrences. */
  public claimOccurrence(occurrenceId: string, now = new Date(Date.now()), timeoutMs = 120_000): Promise<boolean> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      return claimScheduleOccurrence(this.database, occurrenceId, canonicalDate(now), timeoutMs);
    }, signal));
  }

  public settleOccurrence(occurrenceId: string, success: boolean, errorCode?: string, retryable = true, now = new Date(Date.now())): Promise<void> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      settleScheduleOccurrence(this.database, occurrenceId, success, errorCode, retryable, canonicalDate(now));
    }, signal));
  }

  public prepareShutdown(context: SqliteTransactionShutdownContext): void {
    this.owner.prepareShutdown(context);
  }
  public close(context: SqliteTransactionShutdownContext): Promise<void> {
    return this.owner.close(context);
  }

  public pendingWorkflowAgentWork(): Promise<readonly WorkflowAgentWork[]> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted(); return this.workflowExecution.pending();
    }, signal));
  }
  public pendingGoalAutonomy(): Promise<readonly GoalExecutionRecord[]> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      return (this.database.prepare('SELECT goal_json FROM productivity_goals ORDER BY updated_at,goal_id').all() as unknown as GoalRow[])
        .map(row => readPersistedAuthorityJson('productivity', row.goal_json, parseGoalExecutionRecord)).filter(goal => goal.agentExecution !== undefined
          && ['planning', 'executing', 'verifying', 'stopping'].includes(goal.agentExecution.status));
    }, signal));
  }
  public findGoalPlannerTask(sessionId: string, messageId: string): Promise<{ goal: GoalExecutionRecord; task: GoalPlannerTask } | null> {
    return this.owner.schedule(signal => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      for (const row of this.database.prepare('SELECT goal_json FROM productivity_goals').all() as unknown as GoalRow[]) {
        const goal = readPersistedAuthorityJson('productivity', row.goal_json, parseGoalExecutionRecord);
        const task = goal.agentExecution?.tasks.find(item => item.sessionId === sessionId && item.messageId === messageId);
        if (task !== undefined) return { goal, task };
      }
      return null;
    }, signal));
  }
  public claimGoalPlannerTask(goalId: string, attempt: number, now = new Date()): Promise<GoalPlannerTask | null> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      const task = this.readGoal(goalId)?.agentExecution?.tasks.find(item => item.attempt === attempt);
      if (task !== undefined && this.taskIsolation.isQuarantined('goal', goalId, task.todoId)) return null;
      return this.goalAutonomy.claim(goalId, attempt, canonicalDate(now));
    }, signal));
  }
  public recordGoalPlannerSubmission(goalId: string, attempt: number, runId?: string, now = new Date()): Promise<void> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => this.goalAutonomy.submitted(goalId, attempt, runId, canonicalDate(now)), signal));
  }
  public stageGoalDecision(goalId: string, attempt: number,
    input: { runId: string; effectId: string; idempotencyKey: string; decision: GoalDecision }, now = new Date()): Promise<{ staged: true; goalId: string; attempt: number }> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      const goal = this.readGoal(goalId); if (goal === null) throw new ProductivityCommandRejected('goal_not_found');
      return this.goalAutonomy.stage(goal, attempt, input, canonicalDate(now));
    }, signal));
  }
  public settleGoalPlannerTask(goalId: string, attempt: number, outcome: 'completed' | 'failed' | 'cancelled', source?: GoalPlannerResultSource, now = new Date()): Promise<void> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => this.goalAutonomy.settle(goalId, attempt, outcome, source, canonicalDate(now)), signal));
  }
  public pollGoalAutonomy(goalId: string, now = new Date()): Promise<void> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => this.goalAutonomy.poll(goalId, canonicalDate(now)), signal));
  }
  public claimWorkflowAgentTask(workflowId: string, todoId: string, now = new Date()): Promise<WorkflowAgentTask | null> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      if (this.taskIsolation.isQuarantined('workflow', workflowId, todoId)) return null;
      return this.workflowExecution.claim(workflowId, todoId, canonicalDate(now));
    }, signal));
  }
  public recordWorkflowAgentSubmission(workflowId: string, todoId: string, runId?: string, now = new Date()): Promise<void> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted(); this.workflowExecution.submitted(workflowId, todoId, runId, canonicalDate(now));
    }, signal));
  }
  public settleWorkflowAgentTask(workflowId: string, todoId: string,
    outcome: 'completed' | 'failed' | 'cancelled', summary: string, now = new Date(),
    source?: WorkflowTaskResultSource): Promise<void> {
    return this.owner.schedule(signal => this.owner.transaction('write', () => {
      signal.throwIfAborted(); this.workflowExecution.settle(workflowId, todoId, outcome, summary, canonicalDate(now), source);
    }, signal));
  }

  private apply(
    command: Exclude<ProductivityCommand, { kind: 'productivity.query' | 'schedules.query' | 'schedule.occurrences.query' }>,
    now: string, workflowContext?: FrozenConversationContext
  ): ProductivityResult {
    switch (command.kind) {
      case 'goal.put': return this.putGoal(command, now);
      case 'todo.snapshot.replace': return this.replaceTodos(command, now);
      case 'workflow.start': return this.startWorkflow(command, now, workflowContext);
      case 'workflow.advance': return this.advanceWorkflow(command, now);
      case 'workflow.cancel': return this.cancelWorkflow(command, now);
      case 'schedule.create': return this.createSchedule(command, now);
      case 'schedule.transition': return this.transitionSchedule(command, now);
      case 'schedule.occurrence.retry': return retryScheduleOccurrence(this.database, command);
      case 'goal.autonomy.start': {
        const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
        if (workflowContext === undefined) throw new Error('goal_context_required');
        if (this.database.prepare("SELECT 1 FROM productivity_workflows WHERE goal_id=? AND status IN ('running','cancelling')").get(goal.goalId) !== undefined) {
          throw new ProductivityCommandRejected('goal_workflow_still_active');
        }
        return { kind: 'goal.updated', goal: projectGoal(this.goalAutonomy.start(goal, command, workflowContext, now)) };
      }
      case 'goal.autonomy.transition': {
        const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
        if (goal.version !== command.expectedVersion) throw new ProductivityCommandRejected('goal_version_conflict');
        return { kind: 'goal.updated', goal: projectGoal(this.goalAutonomy.transition(goal, command.action, now)) };
      }
    }
  }

  private putGoal(command: Extract<ProductivityCommand, { kind: 'goal.put' }>, now: string): ProductivityResult {
    const current = this.readGoal(command.goalId);
    if ((current?.version ?? null) !== command.expectedVersion) throw new ProductivityCommandRejected('goal_version_conflict');
    if (current !== null && (current.sessionId !== command.sessionId || current.workspaceId !== command.workspaceId)) {
      throw new ProductivityCommandRejected('goal_owner_conflict');
    }
    if (current?.agentExecution !== undefined && command.status === 'active' && current.status !== 'active') {
      throw new ProductivityCommandRejected('goal_autonomy_resume_required');
    }
    if (current?.agentExecution !== undefined && !['paused', 'blocked', 'complete'].includes(current.agentExecution.status)) {
      if (command.title !== current.title || command.phase !== current.phase || command.roundCap !== current.roundCap) throw new ProductivityCommandRejected('goal_autonomy_configuration_locked');
      if (command.status !== current.status && command.status !== 'active') {
        return { kind: 'goal.updated', goal: projectGoal(this.goalAutonomy.requestStop(current, command.status, now)) };
      }
    }
    const goal: Goal = {
      ...(current?.agentExecution === undefined ? {} : { agentExecution: current.agentExecution, autonomy: current.autonomy! }),
      goalId: command.goalId, workspaceId: command.workspaceId, sessionId: command.sessionId,
      version: (current?.version ?? 0) + 1, title: command.title, phase: command.phase,
      status: command.status, roundCap: command.roundCap, roundsUsed: current?.roundsUsed ?? 0,
      updatedAt: now
    };
    const execution = goal.agentExecution;
    const updated = execution !== undefined && command.status !== 'active' && command.status !== current!.status
      ? { ...goal, agentExecution: { ...execution, completedBy: command.status === 'complete' ? 'user' as const : undefined,
        status: command.status, summary: command.status === 'complete' ? '用户标记完成，未进行自主验收。' : '用户已更新目标状态。' } }
      : goal;
    const projected = projectGoal(updated);
    const stored = { ...updated, ...(projected.autonomy === undefined ? {} : { autonomy: projected.autonomy }) };
    this.writeGoal(stored, now);
    return { kind: 'goal.updated', goal: projected };
  }

  private replaceTodos(command: Extract<ProductivityCommand, { kind: 'todo.snapshot.replace' }>, now: string): ProductivityResult {
    const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
    if (goal.version !== command.expectedGoalVersion) throw new ProductivityCommandRejected('goal_version_conflict');
    const current = this.readTodos(goal.goalId);
    if ((current?.revision ?? null) !== command.expectedRevision) throw new ProductivityCommandRejected('todo_revision_conflict');
    const seen = new Set<string>();
    const items: Todo[] = command.items.map((item, ordinal) => {
      if (seen.has(item.todoId)) throw new ProductivityCommandRejected('todo_id_duplicate');
      seen.add(item.todoId);
      return { ...item, ordinal };
    });
    assertTodoDependencies(items);
    const workflows = this.database.prepare(
      `SELECT workflow_json FROM productivity_workflows WHERE goal_id=? AND status IN ('running','cancelling')`
    ).all(goal.goalId) as unknown as WorkflowRow[];
    const replacement = new Map(items.map((item) => [item.todoId, item]));
    const existing = new Map(current?.items.map((item) => [item.todoId, item]) ?? []);
    for (const row of workflows) {
      const workflow = readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
      const boundIds = [...workflow.activeTodoIds, ...workflow.pendingTodoIds, ...workflow.results.map((item) => item.todoId)];
      for (const id of boundIds) {
        const before = existing.get(id);
        const after = replacement.get(id);
        if (before === undefined || after === undefined || before.title !== after.title || before.status !== after.status
          || JSON.stringify(before.dependsOn ?? []) !== JSON.stringify(after.dependsOn ?? [])) {
          throw new ProductivityCommandRejected('todo_bound_to_running_workflow');
        }
      }
    }
    const revision = (current?.revision ?? 0) + 1;
    this.database.prepare(
      `INSERT INTO productivity_todo_snapshots(goal_id,workspace_id,session_id,revision,items_json,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET
       revision=excluded.revision,items_json=excluded.items_json,updated_at=excluded.updated_at`
    ).run(goal.goalId, goal.workspaceId, goal.sessionId, revision, JSON.stringify(items), now);
    return { kind: 'todo.snapshot.replaced', goalId: goal.goalId, revision, items };
  }

  private startWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.start' }>, now: string, context?: FrozenConversationContext, goalOwned = false): ProductivityResult {
    const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
    if (!goalOwned && goal.agentExecution !== undefined && !['paused', 'blocked', 'complete'].includes(goal.agentExecution.status)) {
      throw new ProductivityCommandRejected('workflow_goal_autonomy_owned');
    }
    if (goal.version !== command.expectedGoalVersion || goal.status !== 'active') throw new ProductivityCommandRejected('workflow_goal_unavailable');
    if (goal.roundsUsed >= goal.roundCap) throw new ProductivityCommandRejected('workflow_goal_round_cap_reached');
    const todos = this.readTodos(goal.goalId);
    if (todos?.revision !== command.expectedTodoRevision) throw new ProductivityCommandRejected('todo_revision_conflict');
    if (this.readWorkflow(command.workflowId) !== null) throw new ProductivityCommandRejected('workflow_exists');
    if (command.maxTransitions < command.todoIds.length) throw new ProductivityCommandRejected('workflow_budget_insufficient');
    const running = this.database.prepare(
      `SELECT workflow_json FROM productivity_workflows WHERE goal_id=? AND status IN ('running','cancelling')`
    ).all(goal.goalId) as unknown as WorkflowRow[];
    const claimed = new Set(running.flatMap((row) => {
      const workflow = readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
      return [...workflow.activeTodoIds, ...workflow.pendingTodoIds];
    }));
    const available = new Map(todos.items.map((item) => [item.todoId, item]));
    if (new Set(command.todoIds).size !== command.todoIds.length || command.todoIds.some((id) => claimed.has(id) || available.get(id)?.status !== 'pending')) {
      throw new ProductivityCommandRejected('workflow_todo_unavailable');
    }
    if (Date.parse(command.deadlineAt) <= Date.parse(now)) throw new ProductivityCommandRejected('workflow_deadline_invalid');
    const dependencies = workflowDependenciesForSelection(todos.items, command.todoIds);
    const activeTodoIds = readyWorkflowTodoIds({ dependencies, results: [], pendingTodoIds: command.todoIds }, command.maxConcurrency);
    if (activeTodoIds.length === 0) throw new ProductivityCommandRejected('workflow_dependency_unavailable');
    const workflow: Workflow = {
      workflowId: command.workflowId, goalId: goal.goalId, version: 1, status: 'running',
      maxConcurrency: command.maxConcurrency, maxTransitions: command.maxTransitions,
      transitionsUsed: 0, deadlineAt: command.deadlineAt,
      activeTodoIds, dependencies,
      pendingTodoIds: command.todoIds.filter(id => !activeTodoIds.includes(id)), results: [],
      ...(command.executionMode === 'agent' ? { executionMode: 'agent' as const,
        agentExecution: createWorkflowAgentExecution(command.workflowId, goal.title,
          command.todoIds.map(todoId => ({ ...available.get(todoId)!, priorCompletedDependencies:
            (available.get(todoId)!.dependsOn ?? []).filter(id => !command.todoIds.includes(id))
              .map(id => ({ todoId: id, title: available.get(id)!.title })) })), context,
            goalOwned ? goal.agentExecution!.criteria : undefined) } : {})
    };
    const advancedGoal: Goal = {
      ...goal, version: goal.version + 1, roundsUsed: goal.roundsUsed + 1, updatedAt: now
    };
    this.writeGoal(advancedGoal, now);
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    this.updateTodoStates(goal.goalId, new Map(workflow.activeTodoIds.map((id) => [id, 'in_progress'])), now);
    return { kind: 'workflow.updated', workflow: projectWorkflow(workflow) };
  }

  private advanceWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.advance' }>, now: string): ProductivityResult {
    const current = this.requireWorkflow(command.workflowId, command.workspaceId, command.sessionId);
    if (current.agentExecution !== undefined) throw new ProductivityCommandRejected('workflow_agent_result_owned');
    if (current.version !== command.expectedVersion || current.status !== 'running') throw new ProductivityCommandRejected('workflow_version_conflict');
    if (Date.parse(now) >= Date.parse(current.deadlineAt)) return this.terminalizeExpired(current, command.workspaceId, command.sessionId, now);
    const active = new Set(current.activeTodoIds);
    if (new Set(command.completed.map((item) => item.todoId)).size !== command.completed.length || command.completed.some((item) => !active.has(item.todoId))) {
      throw new ProductivityCommandRejected('workflow_completion_not_active');
    }
    const transitionsUsed = current.transitionsUsed + command.completed.length;
    if (transitionsUsed > current.maxTransitions) throw new ProductivityCommandRejected('workflow_budget_exceeded');
    const results = [...current.results, ...command.completed];
    const failed = command.completed.some((item) => item.outcome === 'failed');
    const remainingActive = current.activeTodoIds.filter((id) => !command.completed.some((item) => item.todoId === id));
    const openSlots = current.maxConcurrency - remainingActive.length;
    const activated = failed ? [] : readyWorkflowTodoIds({ ...current, results }, openSlots);
    const cancelled = failed ? [...remainingActive, ...current.pendingTodoIds] : [];
    results.push(...cancelled.map((todoId) => ({ todoId, outcome: 'cancelled' as const, summary: 'workflow_failed' })));
    const pendingTodoIds = failed ? [] : current.pendingTodoIds.filter(id => !activated.includes(id));
    const activeTodoIds = failed ? [] : [...remainingActive, ...activated];
    const status: Workflow['status'] = failed ? 'failed' : activeTodoIds.length === 0 && pendingTodoIds.length === 0 ? 'completed' : 'running';
    const workflow: Workflow = { ...current, version: current.version + 1, transitionsUsed, results, activeTodoIds, pendingTodoIds, status };
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    const states = new Map<string, Todo['status']>();
    for (const item of command.completed) states.set(item.todoId, item.outcome);
    for (const id of activated) states.set(id, 'in_progress');
    for (const id of cancelled) states.set(id, 'cancelled');
    this.updateTodoStates(current.goalId, states, now);
    return { kind: 'workflow.updated', workflow };
  }

  private cancelWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.cancel' }>, now: string): ProductivityResult {
    const current = this.requireWorkflow(command.workflowId, command.workspaceId, command.sessionId);
    if (current.version !== command.expectedVersion || !['running', 'cancelling'].includes(current.status)) throw new ProductivityCommandRejected('workflow_version_conflict');
    if (current.agentExecution !== undefined) {
      const workflow = this.workflowExecution.requestStop({ workflow: current, workspaceId: command.workspaceId,
        sessionId: command.sessionId, goalStatus: this.requireGoal(current.goalId, command.workspaceId, command.sessionId).status },
      'cancelled', 'workflow_cancelled', now);
      return { kind: 'workflow.updated', workflow: projectWorkflow(workflow) };
    }
    const cancelled = [...current.activeTodoIds, ...current.pendingTodoIds];
    const workflow: Workflow = {
      ...current, version: current.version + 1, status: 'cancelled', activeTodoIds: [], pendingTodoIds: [],
      results: [...current.results, ...cancelled.map((todoId) => ({ todoId, outcome: 'cancelled' as const, summary: 'workflow_cancelled' }))]
    };
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    this.updateTodoStates(current.goalId, new Map(cancelled.map((id) => [id, 'cancelled'])), now);
    return { kind: 'workflow.updated', workflow };
  }

  private createSchedule(command: Extract<ProductivityCommand, { kind: 'schedule.create' }>, now: string): ProductivityResult {
    if (this.readSchedule(command.scheduleId) !== null) throw new ProductivityCommandRejected('schedule_exists');
    const skippedPastOnce = command.timing.kind === 'once'
      && command.timing.missPolicy === 'skip'
      && Date.parse(command.timing.at) <= Date.parse(now);
    const schedule: Schedule = {
      scheduleId: command.scheduleId, workspaceId: command.workspaceId, sessionId: command.sessionId,
      version: 1, status: skippedPastOnce ? 'completed' : 'active', prompt: command.prompt, timing: command.timing,
      nextFireAt: skippedPastOnce ? null : firstFire(command.timing, new Date(now)), fireCount: 0
    };
    this.writeSchedule(schedule, now);
    return { kind: 'schedule.updated', schedule };
  }

  private transitionSchedule(command: Extract<ProductivityCommand, { kind: 'schedule.transition' }>, now: string): ProductivityResult {
    const current = this.requireSchedule(command.scheduleId, command.workspaceId, command.sessionId);
    if (current.version !== command.expectedVersion || current.status === 'cancelled'
      || (current.status === 'completed' && command.action !== 'cancel')) throw new ProductivityCommandRejected('schedule_version_conflict');
    const skippedPastOnce = command.action === 'resume'
      && current.timing.kind === 'once'
      && current.timing.missPolicy === 'skip'
      && current.nextFireAt !== null
      && Date.parse(current.nextFireAt) <= Date.parse(now);
    const status = skippedPastOnce ? 'completed'
      : command.action === 'pause' ? 'paused'
        : command.action === 'resume' ? 'active' : 'cancelled';
    const schedule: Schedule = {
      ...current, version: current.version + 1, status,
      nextFireAt: status === 'completed' || status === 'cancelled' ? null
        : status === 'active' && current.nextFireAt === null ? firstFire(current.timing, new Date(now)) : current.nextFireAt
    };
    this.writeSchedule(schedule, now);
    if (status === 'cancelled') {
      this.database.prepare(
        `UPDATE productivity_schedule_occurrences SET status='cancelled',last_error='schedule_cancelled'
         WHERE schedule_id=? AND status='pending'`
      ).run(schedule.scheduleId);
    }
    return { kind: 'schedule.updated', schedule };
  }

  private readGoal(goalId: string): Goal | null {
    const row = this.database.prepare('SELECT goal_json FROM productivity_goals WHERE goal_id=?').get(goalId) as GoalRow | undefined;
    return row === undefined ? null : readPersistedAuthorityJson('productivity', row.goal_json, parseGoalExecutionRecord);
  }
  private readGoalForSession(workspaceId: string, sessionId: string): Goal | null {
    const row = this.database.prepare('SELECT goal_json FROM productivity_goals WHERE workspace_id=? AND session_id=? ORDER BY updated_at DESC LIMIT 1').get(workspaceId, sessionId) as GoalRow | undefined;
    return row === undefined ? null : readPersistedAuthorityJson('productivity', row.goal_json, parseGoalExecutionRecord);
  }
  private writeGoal(goal: Goal, now: string): void {
    parseGoalExecutionRecord(goal);
    this.database.prepare(`INSERT INTO productivity_goals(goal_id,workspace_id,session_id,version,status,goal_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET version=excluded.version,status=excluded.status,
      goal_json=excluded.goal_json,updated_at=excluded.updated_at`)
      .run(goal.goalId, goal.workspaceId, goal.sessionId, goal.version, goal.status, JSON.stringify(goal), now);
    if (goal.agentExecution !== undefined) this.database.prepare('INSERT INTO productivity_events(command_id,kind,event_json,occurred_at) VALUES(?,?,?,?)')
      .run(stableId('goal-execution-version', goal.goalId, String(goal.version)), 'goal.execution.updated', JSON.stringify(goal), now);
  }
  private requireGoal(goalId: string, workspaceId: string, sessionId: string): Goal {
    const goal = this.readGoal(goalId);
    if (goal === null || goal.workspaceId !== workspaceId || goal.sessionId !== sessionId) throw new ProductivityCommandRejected('goal_not_found');
    return goal;
  }
  private readTodos(goalId: string): { revision: number; items: Todo[] } | null {
    const row = this.database.prepare('SELECT revision,items_json FROM productivity_todo_snapshots WHERE goal_id=?').get(goalId) as TodoRow | undefined;
    return row === undefined ? null : { revision: row.revision, items: readPersistedAuthorityJson('productivity', row.items_json, value => {
      const result = runtimeResultSchema.parse({ kind: 'todo.snapshot.replaced', goalId, revision: row.revision, items: value });
      if (result.kind !== 'todo.snapshot.replaced') throw new Error('productivity_todo_record_invalid');
      return result.items;
    }) };
  }
  private updateTodoStates(goalId: string, states: ReadonlyMap<string, Todo['status']>, now: string): void {
    if (states.size === 0) return;
    const current = this.readTodos(goalId);
    if (current === null) throw new Error('todo_snapshot_not_found');
    const existing = new Set(current.items.map((item) => item.todoId));
    if ([...states.keys()].some((id) => !existing.has(id))) throw new Error('workflow_todo_reference_missing');
    const items = current.items.map((item) => states.has(item.todoId) ? { ...item, status: states.get(item.todoId)! } : item);
    this.database.prepare('UPDATE productivity_todo_snapshots SET revision=?,items_json=?,updated_at=? WHERE goal_id=?').run(current.revision + 1, JSON.stringify(items), now, goalId);
  }
  private readWorkflow(id: string): Workflow | null {
    const row = this.database.prepare('SELECT workflow_json FROM productivity_workflows WHERE workflow_id=?').get(id) as WorkflowRow | undefined;
    return row === undefined ? null : readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
  }
  private requireWorkflow(id: string, workspaceId: string, sessionId: string): Workflow {
    const row = this.database.prepare('SELECT workflow_json FROM productivity_workflows WHERE workflow_id=? AND workspace_id=? AND session_id=?').get(id, workspaceId, sessionId) as WorkflowRow | undefined;
    if (row === undefined) throw new ProductivityCommandRejected('workflow_not_found');
    return readPersistedAuthorityJson('productivity', row.workflow_json, parseWorkflowExecutionRecord);
  }
  private writeWorkflow(workflow: Workflow, workspaceId: string, sessionId: string, now: string): void {
    parseWorkflowExecutionRecord(workflow);
    this.database.prepare(`INSERT INTO productivity_workflows(workflow_id,goal_id,workspace_id,session_id,version,status,workflow_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET version=excluded.version,status=excluded.status,workflow_json=excluded.workflow_json,updated_at=excluded.updated_at`).run(workflow.workflowId, workflow.goalId, workspaceId, sessionId, workflow.version, workflow.status, JSON.stringify(workflow), now);
    if (workflow.agentExecution !== undefined) {
      this.database.prepare('INSERT INTO productivity_events(command_id,kind,event_json,occurred_at) VALUES(?,?,?,?)')
        .run(stableId('workflow-execution-version', workflow.workflowId, String(workflow.version)),
          'workflow.execution.updated', JSON.stringify(workflow), now);
    }
  }
  private terminalizeExpired(current: Workflow, workspaceId: string, sessionId: string, now: string): ProductivityResult {
    if (current.agentExecution !== undefined) {
      const workflow = this.workflowExecution.requestStop({ workflow: current, workspaceId, sessionId,
        goalStatus: this.requireGoal(current.goalId, workspaceId, sessionId).status }, 'failed', 'workflow_deadline_exceeded', now);
      return { kind: 'workflow.updated', workflow: projectWorkflow(workflow) };
    }
    const cancelled = [...current.activeTodoIds, ...current.pendingTodoIds];
    const workflow: Workflow = { ...current, version: current.version + 1, status: 'failed', activeTodoIds: [], pendingTodoIds: [], results: [...current.results, ...cancelled.map((todoId) => ({ todoId, outcome: 'cancelled' as const, summary: 'workflow_deadline_exceeded' }))] };
    this.writeWorkflow(workflow, workspaceId, sessionId, now);
    this.updateTodoStates(current.goalId, new Map(cancelled.map((id) => [id, 'cancelled'])), now);
    return { kind: 'workflow.updated', workflow };
  }
  private readSchedule(id: string): Schedule | null {
    const row = this.database.prepare('SELECT schedule_json FROM productivity_schedules WHERE schedule_id=?').get(id) as ScheduleRow | undefined;
    return row === undefined ? null : parseSchedule(row);
  }
  private requireSchedule(id: string, workspaceId: string, sessionId: string): Schedule {
    const schedule = this.readSchedule(id);
    if (schedule === null || schedule.workspaceId !== workspaceId || schedule.sessionId !== sessionId) throw new ProductivityCommandRejected('schedule_not_found');
    return schedule;
  }
  private writeSchedule(schedule: Schedule, now: string): void {
    this.database.prepare(`INSERT INTO productivity_schedules(schedule_id,workspace_id,session_id,version,status,next_fire_at,schedule_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET version=excluded.version,status=excluded.status,next_fire_at=excluded.next_fire_at,schedule_json=excluded.schedule_json,updated_at=excluded.updated_at`).run(schedule.scheduleId, schedule.workspaceId, schedule.sessionId, schedule.version, schedule.status, schedule.nextFireAt, JSON.stringify(schedule), now, now);
  }
}

function firstFire(timing: Schedule['timing'], now: Date): string {
  if (timing.kind === 'once') return canonicalDate(new Date(timing.at));
  if (timing.kind === 'interval') return new Date(now.getTime() + timing.intervalMs).toISOString();
  const next = new Cron(timing.expression, { timezone: timing.timezone, paused: true }).nextRun(now);
  if (next === null) throw new ProductivityCommandRejected('schedule_cron_has_no_next_run');
  return next.toISOString();
}
function nextSchedule(schedule: Schedule, now: Date): Schedule {
  if (schedule.timing.kind === 'once') return { ...schedule, version: schedule.version + 1, status: 'completed', nextFireAt: null, fireCount: schedule.fireCount + 1 };
  return { ...schedule, version: schedule.version + 1, nextFireAt: firstFire(schedule.timing, now), fireCount: schedule.fireCount + 1 };
}
function parseSchedule(row: ScheduleRow): Schedule {
  return readPersistedAuthorityJson('productivity', row.schedule_json, value => {
    const result = runtimeResultSchema.parse({ kind: 'schedule.updated', schedule: value });
    if (result.kind !== 'schedule.updated') throw new Error('productivity_schedule_record_invalid');
    return result.schedule;
  });
}
function stableId(...parts: string[]): string { return `id-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`; }
function canonicalDate(value: Date): string { if (!Number.isFinite(value.getTime())) throw new Error('productivity_clock_invalid'); return value.toISOString(); }
