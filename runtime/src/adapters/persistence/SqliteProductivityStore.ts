import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Cron } from 'croner';

import type { ProductivityCommand, ProductivityResult } from '@ariadne/protocol/public';
import { acquireSqliteOwnerLease, closeOwnedSqliteDatabase } from './SqliteOwnerLease.js';
import { SqliteTransactionOwner, type SqliteTransactionShutdownContext } from './SqliteTransactionOwner.js';

export const PRODUCTIVITY_DB_SCHEMA_VERSION = 1;

type Goal = Extract<ProductivityResult, { kind: 'goal.updated.v3' }>['goal'];
type Todo = Extract<ProductivityResult, { kind: 'todo.snapshot.replaced.v3' }>['items'][number];
type Workflow = Extract<ProductivityResult, { kind: 'workflow.updated.v3' }>['workflow'];
type Schedule = Extract<ProductivityResult, { kind: 'schedule.updated.v3' }>['schedule'];

interface GoalRow { goal_json: string }
interface TodoRow { revision: number; items_json: string }
interface WorkflowRow { workflow_json: string }
interface ScheduleRow { schedule_json: string }
interface CommandRow { fingerprint: string; result_json: string }
interface OccurrenceRow {
  occurrence_id: string; schedule_id: string; workspace_id: string; session_id: string;
  prompt: string; due_at: string; command_id: string; message_id: string; attempts: number;
}

export interface DueScheduleOccurrence {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly dueAt: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly attempts: number;
}

/** Versioned Goal/Todo/Workflow/Schedule authority; it executes no host code. */
export class SqliteProductivityStore {
  private readonly database: DatabaseSync;
  private readonly owner: SqliteTransactionOwner;

  public constructor(dataRoot: string) {
    const databasePath = path.resolve(dataRoot, 'data', 'productivity', 'productivity.db');
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const lease = acquireSqliteOwnerLease(databasePath, 'productivity');
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
      initializeSchema(database);
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.database = database;
      this.owner = new SqliteTransactionOwner(database, databasePath, lease, {
        shutdownRequestedCode: 'productivity_shutdown_requested',
        closedCode: 'productivity_store_closed',
        shutdownConflictCode: 'productivity_shutdown_context_conflict',
        transactionActiveCode: 'productivity_transaction_already_active',
        shutdownDeadlineCode: 'productivity_shutdown_deadline_exceeded'
      });
    } catch (error) {
      if (database === null) lease.close();
      else try { closeOwnedSqliteDatabase(database, lease); } catch { /* keep opening error */ }
      throw error;
    }
  }

  public execute(
    commandId: string,
    command: Exclude<ProductivityCommand, { kind: 'productivity.query.v3' | 'schedules.query.v3' }>,
    now = new Date()
  ): Promise<ProductivityResult> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      const fingerprint = digestJson(command);
      const replay = this.database.prepare(
        'SELECT fingerprint, result_json FROM productivity_commands WHERE command_id=?'
      ).get(commandId) as CommandRow | undefined;
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint) throw new Error('productivity_command_conflict');
        return JSON.parse(replay.result_json) as ProductivityResult;
      }
      const occurredAt = canonicalDate(now);
      const result = this.apply(command, occurredAt);
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
    command: Exclude<ProductivityCommand, { kind: 'productivity.query.v3' | 'schedules.query.v3' }>
  ): Promise<ProductivityResult | null> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const replay = this.database.prepare(
        'SELECT fingerprint, result_json FROM productivity_commands WHERE command_id=?'
      ).get(commandId) as CommandRow | undefined;
      if (replay === undefined) return null;
      if (replay.fingerprint !== digestJson(command)) throw new Error('productivity_command_conflict');
      return JSON.parse(replay.result_json) as ProductivityResult;
    }, signal));
  }

  public query(workspaceId: string, sessionId: string): Promise<Extract<
    ProductivityResult, { kind: 'productivity.query_result.v3' }
  >> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const goal = this.readGoalForSession(workspaceId, sessionId);
      const todos = goal === null ? null : this.readTodos(goal.goalId);
      const workflows = this.database.prepare(
        'SELECT workflow_json FROM productivity_workflows WHERE workspace_id=? AND session_id=? ORDER BY updated_at,workflow_id'
      ).all(workspaceId, sessionId) as unknown as WorkflowRow[];
      return {
        kind: 'productivity.query_result.v3',
        goal,
        todoRevision: todos?.revision ?? null,
        todos: todos?.items ?? [],
        workflows: workflows.map((row) => JSON.parse(row.workflow_json) as Workflow)
      };
    }, signal));
  }

  public querySchedules(workspaceId: string, sessionId: string): Promise<Extract<
    ProductivityResult, { kind: 'schedules.query_result.v3' }
  >> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const rows = this.database.prepare(
        'SELECT schedule_json FROM productivity_schedules WHERE workspace_id=? AND session_id=? ORDER BY created_at,schedule_id'
      ).all(workspaceId, sessionId) as unknown as ScheduleRow[];
      return { kind: 'schedules.query_result.v3', schedules: rows.map(parseSchedule) };
    }, signal));
  }

  public materializeDue(now = new Date()): Promise<void> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      const nowIso = canonicalDate(now);
      const rows = this.database.prepare(
        `SELECT schedule_json FROM productivity_schedules
         WHERE status='active' AND next_fire_at IS NOT NULL AND next_fire_at<=?
         ORDER BY next_fire_at,schedule_id LIMIT 64`
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

  public pendingOccurrences(limit = 16): Promise<readonly DueScheduleOccurrence[]> {
    return this.owner.schedule((signal) => this.owner.transaction('read', () => {
      signal.throwIfAborted();
      const rows = this.database.prepare(
        `SELECT occurrence_id,schedule_id,workspace_id,session_id,prompt,due_at,command_id,message_id,attempts
         FROM productivity_schedule_occurrences WHERE status='pending'
         ORDER BY due_at,occurrence_id LIMIT ?`
      ).all(limit) as unknown as OccurrenceRow[];
      return rows.map((row) => ({
        occurrenceId: row.occurrence_id, scheduleId: row.schedule_id,
        workspaceId: row.workspace_id, sessionId: row.session_id, prompt: row.prompt,
        dueAt: row.due_at, commandId: row.command_id, messageId: row.message_id,
        attempts: row.attempts
      }));
    }, signal));
  }

  public settleOccurrence(occurrenceId: string, success: boolean, errorCode?: string): Promise<void> {
    return this.owner.schedule((signal) => this.owner.transaction('write', () => {
      signal.throwIfAborted();
      const result = this.database.prepare(
        `UPDATE productivity_schedule_occurrences
         SET status=?,attempts=attempts+1,last_error=? WHERE occurrence_id=? AND status='pending'`
      ).run(success ? 'submitted' : 'pending', success ? null : errorCode ?? 'schedule_dispatch_failed', occurrenceId);
      if (result.changes !== 1) throw new Error('schedule_occurrence_not_pending');
    }, signal));
  }

  public prepareShutdown(context: SqliteTransactionShutdownContext): void {
    this.owner.prepareShutdown(context);
  }
  public close(context: SqliteTransactionShutdownContext): Promise<void> {
    return this.owner.close(context);
  }

  private apply(
    command: Exclude<ProductivityCommand, { kind: 'productivity.query.v3' | 'schedules.query.v3' }>,
    now: string
  ): ProductivityResult {
    switch (command.kind) {
      case 'goal.put.v3': return this.putGoal(command, now);
      case 'todo.snapshot.replace.v3': return this.replaceTodos(command, now);
      case 'workflow.start.v3': return this.startWorkflow(command, now);
      case 'workflow.advance.v3': return this.advanceWorkflow(command, now);
      case 'workflow.cancel.v3': return this.cancelWorkflow(command, now);
      case 'schedule.create.v3': return this.createSchedule(command, now);
      case 'schedule.transition.v3': return this.transitionSchedule(command, now);
    }
  }

  private putGoal(command: Extract<ProductivityCommand, { kind: 'goal.put.v3' }>, now: string): ProductivityResult {
    const current = this.readGoal(command.goalId);
    if ((current?.version ?? null) !== command.expectedVersion) throw new Error('goal_version_conflict');
    if (current !== null && (current.sessionId !== command.sessionId || current.workspaceId !== command.workspaceId)) {
      throw new Error('goal_owner_conflict');
    }
    const goal: Goal = {
      goalId: command.goalId, workspaceId: command.workspaceId, sessionId: command.sessionId,
      version: (current?.version ?? 0) + 1, title: command.title, phase: command.phase,
      status: command.status, roundCap: command.roundCap, roundsUsed: current?.roundsUsed ?? 0,
      updatedAt: now
    };
    this.database.prepare(
      `INSERT INTO productivity_goals(goal_id,workspace_id,session_id,version,status,goal_json,updated_at)
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET
       version=excluded.version,status=excluded.status,goal_json=excluded.goal_json,updated_at=excluded.updated_at`
    ).run(goal.goalId, goal.workspaceId, goal.sessionId, goal.version, goal.status, JSON.stringify(goal), now);
    return { kind: 'goal.updated.v3', goal };
  }

  private replaceTodos(command: Extract<ProductivityCommand, { kind: 'todo.snapshot.replace.v3' }>, now: string): ProductivityResult {
    const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
    if (goal.version !== command.expectedGoalVersion) throw new Error('goal_version_conflict');
    const current = this.readTodos(goal.goalId);
    if ((current?.revision ?? null) !== command.expectedRevision) throw new Error('todo_revision_conflict');
    const seen = new Set<string>();
    const items: Todo[] = command.items.map((item, ordinal) => {
      if (seen.has(item.todoId)) throw new Error('todo_id_duplicate');
      seen.add(item.todoId);
      return { ...item, ordinal };
    });
    const revision = (current?.revision ?? 0) + 1;
    this.database.prepare(
      `INSERT INTO productivity_todo_snapshots(goal_id,workspace_id,session_id,revision,items_json,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET
       revision=excluded.revision,items_json=excluded.items_json,updated_at=excluded.updated_at`
    ).run(goal.goalId, goal.workspaceId, goal.sessionId, revision, JSON.stringify(items), now);
    return { kind: 'todo.snapshot.replaced.v3', goalId: goal.goalId, revision, items };
  }

  private startWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.start.v3' }>, now: string): ProductivityResult {
    const goal = this.requireGoal(command.goalId, command.workspaceId, command.sessionId);
    if (goal.version !== command.expectedGoalVersion || goal.status !== 'active') throw new Error('workflow_goal_unavailable');
    if (goal.roundsUsed >= goal.roundCap) throw new Error('workflow_goal_round_cap_reached');
    const todos = this.readTodos(goal.goalId);
    if (todos?.revision !== command.expectedTodoRevision) throw new Error('todo_revision_conflict');
    if (this.readWorkflow(command.workflowId) !== null) throw new Error('workflow_exists');
    const available = new Map(todos.items.map((item) => [item.todoId, item]));
    if (new Set(command.todoIds).size !== command.todoIds.length || command.todoIds.some((id) => available.get(id)?.status !== 'pending')) {
      throw new Error('workflow_todo_unavailable');
    }
    if (Date.parse(command.deadlineAt) <= Date.parse(now)) throw new Error('workflow_deadline_invalid');
    const workflow: Workflow = {
      workflowId: command.workflowId, goalId: goal.goalId, version: 1, status: 'running',
      maxConcurrency: command.maxConcurrency, maxTransitions: command.maxTransitions,
      transitionsUsed: 0, deadlineAt: command.deadlineAt,
      activeTodoIds: command.todoIds.slice(0, command.maxConcurrency),
      pendingTodoIds: command.todoIds.slice(command.maxConcurrency), results: []
    };
    const advancedGoal: Goal = {
      ...goal, version: goal.version + 1, roundsUsed: goal.roundsUsed + 1, updatedAt: now
    };
    this.database.prepare(
      'UPDATE productivity_goals SET version=?,goal_json=?,updated_at=? WHERE goal_id=?'
    ).run(advancedGoal.version, JSON.stringify(advancedGoal), now, advancedGoal.goalId);
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    this.updateTodoStates(goal.goalId, new Map(workflow.activeTodoIds.map((id) => [id, 'in_progress'])), now);
    return { kind: 'workflow.updated.v3', workflow };
  }

  private advanceWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.advance.v3' }>, now: string): ProductivityResult {
    const current = this.requireWorkflow(command.workflowId, command.workspaceId, command.sessionId);
    if (current.version !== command.expectedVersion || current.status !== 'running') throw new Error('workflow_version_conflict');
    if (Date.parse(now) > Date.parse(current.deadlineAt)) return this.terminalizeExpired(current, command.workspaceId, command.sessionId, now);
    const active = new Set(current.activeTodoIds);
    if (new Set(command.completed.map((item) => item.todoId)).size !== command.completed.length || command.completed.some((item) => !active.has(item.todoId))) {
      throw new Error('workflow_completion_not_active');
    }
    const transitionsUsed = current.transitionsUsed + command.completed.length;
    if (transitionsUsed > current.maxTransitions) throw new Error('workflow_budget_exceeded');
    const results = [...current.results, ...command.completed];
    const failed = command.completed.some((item) => item.outcome === 'failed');
    const remainingActive = current.activeTodoIds.filter((id) => !command.completed.some((item) => item.todoId === id));
    const openSlots = current.maxConcurrency - remainingActive.length;
    const activated = failed ? [] : current.pendingTodoIds.slice(0, openSlots);
    const pendingTodoIds = failed ? current.pendingTodoIds : current.pendingTodoIds.slice(openSlots);
    const activeTodoIds = [...remainingActive, ...activated];
    const status: Workflow['status'] = failed ? 'failed' : activeTodoIds.length === 0 && pendingTodoIds.length === 0 ? 'completed' : 'running';
    const workflow: Workflow = { ...current, version: current.version + 1, transitionsUsed, results, activeTodoIds, pendingTodoIds, status };
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    const states = new Map<string, Todo['status']>();
    for (const item of command.completed) states.set(item.todoId, item.outcome === 'completed' ? 'completed' : 'cancelled');
    for (const id of activated) states.set(id, 'in_progress');
    if (failed) for (const id of [...remainingActive, ...pendingTodoIds]) states.set(id, 'cancelled');
    this.updateTodoStates(current.goalId, states, now);
    return { kind: 'workflow.updated.v3', workflow };
  }

  private cancelWorkflow(command: Extract<ProductivityCommand, { kind: 'workflow.cancel.v3' }>, now: string): ProductivityResult {
    const current = this.requireWorkflow(command.workflowId, command.workspaceId, command.sessionId);
    if (current.version !== command.expectedVersion || current.status !== 'running') throw new Error('workflow_version_conflict');
    const cancelled = [...current.activeTodoIds, ...current.pendingTodoIds];
    const workflow: Workflow = {
      ...current, version: current.version + 1, status: 'cancelled', activeTodoIds: [], pendingTodoIds: [],
      results: [...current.results, ...cancelled.map((todoId) => ({ todoId, outcome: 'cancelled' as const, summary: 'workflow_cancelled' }))]
    };
    this.writeWorkflow(workflow, command.workspaceId, command.sessionId, now);
    this.updateTodoStates(current.goalId, new Map(cancelled.map((id) => [id, 'cancelled'])), now);
    return { kind: 'workflow.updated.v3', workflow };
  }

  private createSchedule(command: Extract<ProductivityCommand, { kind: 'schedule.create.v3' }>, now: string): ProductivityResult {
    if (this.readSchedule(command.scheduleId) !== null) throw new Error('schedule_exists');
    const skippedPastOnce = command.timing.kind === 'once'
      && command.timing.missPolicy === 'skip'
      && Date.parse(command.timing.at) <= Date.parse(now);
    const schedule: Schedule = {
      scheduleId: command.scheduleId, workspaceId: command.workspaceId, sessionId: command.sessionId,
      version: 1, status: skippedPastOnce ? 'completed' : 'active', prompt: command.prompt, timing: command.timing,
      nextFireAt: skippedPastOnce ? null : firstFire(command.timing, new Date(now)), fireCount: 0
    };
    this.writeSchedule(schedule, now);
    return { kind: 'schedule.updated.v3', schedule };
  }

  private transitionSchedule(command: Extract<ProductivityCommand, { kind: 'schedule.transition.v3' }>, now: string): ProductivityResult {
    const current = this.requireSchedule(command.scheduleId, command.workspaceId, command.sessionId);
    if (current.version !== command.expectedVersion || current.status === 'completed' || current.status === 'cancelled') throw new Error('schedule_version_conflict');
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
    return { kind: 'schedule.updated.v3', schedule };
  }

  private readGoal(goalId: string): Goal | null {
    const row = this.database.prepare('SELECT goal_json FROM productivity_goals WHERE goal_id=?').get(goalId) as GoalRow | undefined;
    return row === undefined ? null : JSON.parse(row.goal_json) as Goal;
  }
  private readGoalForSession(workspaceId: string, sessionId: string): Goal | null {
    const row = this.database.prepare('SELECT goal_json FROM productivity_goals WHERE workspace_id=? AND session_id=? ORDER BY updated_at DESC LIMIT 1').get(workspaceId, sessionId) as GoalRow | undefined;
    return row === undefined ? null : JSON.parse(row.goal_json) as Goal;
  }
  private requireGoal(goalId: string, workspaceId: string, sessionId: string): Goal {
    const goal = this.readGoal(goalId);
    if (goal === null || goal.workspaceId !== workspaceId || goal.sessionId !== sessionId) throw new Error('goal_not_found');
    return goal;
  }
  private readTodos(goalId: string): { revision: number; items: Todo[] } | null {
    const row = this.database.prepare('SELECT revision,items_json FROM productivity_todo_snapshots WHERE goal_id=?').get(goalId) as TodoRow | undefined;
    return row === undefined ? null : { revision: row.revision, items: JSON.parse(row.items_json) as Todo[] };
  }
  private updateTodoStates(goalId: string, states: ReadonlyMap<string, Todo['status']>, now: string): void {
    if (states.size === 0) return;
    const current = this.readTodos(goalId);
    if (current === null) throw new Error('todo_snapshot_not_found');
    const items = current.items.map((item) => states.has(item.todoId) ? { ...item, status: states.get(item.todoId)! } : item);
    this.database.prepare('UPDATE productivity_todo_snapshots SET revision=?,items_json=?,updated_at=? WHERE goal_id=?').run(current.revision + 1, JSON.stringify(items), now, goalId);
  }
  private readWorkflow(id: string): Workflow | null {
    const row = this.database.prepare('SELECT workflow_json FROM productivity_workflows WHERE workflow_id=?').get(id) as WorkflowRow | undefined;
    return row === undefined ? null : JSON.parse(row.workflow_json) as Workflow;
  }
  private requireWorkflow(id: string, workspaceId: string, sessionId: string): Workflow {
    const row = this.database.prepare('SELECT workflow_json FROM productivity_workflows WHERE workflow_id=? AND workspace_id=? AND session_id=?').get(id, workspaceId, sessionId) as WorkflowRow | undefined;
    if (row === undefined) throw new Error('workflow_not_found');
    return JSON.parse(row.workflow_json) as Workflow;
  }
  private writeWorkflow(workflow: Workflow, workspaceId: string, sessionId: string, now: string): void {
    this.database.prepare(`INSERT INTO productivity_workflows(workflow_id,goal_id,workspace_id,session_id,version,status,workflow_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET version=excluded.version,status=excluded.status,workflow_json=excluded.workflow_json,updated_at=excluded.updated_at`).run(workflow.workflowId, workflow.goalId, workspaceId, sessionId, workflow.version, workflow.status, JSON.stringify(workflow), now);
  }
  private terminalizeExpired(current: Workflow, workspaceId: string, sessionId: string, now: string): ProductivityResult {
    const cancelled = [...current.activeTodoIds, ...current.pendingTodoIds];
    const workflow: Workflow = { ...current, version: current.version + 1, status: 'failed', activeTodoIds: [], pendingTodoIds: [], results: [...current.results, ...cancelled.map((todoId) => ({ todoId, outcome: 'cancelled' as const, summary: 'workflow_deadline_exceeded' }))] };
    this.writeWorkflow(workflow, workspaceId, sessionId, now);
    this.updateTodoStates(current.goalId, new Map(cancelled.map((id) => [id, 'cancelled'])), now);
    return { kind: 'workflow.updated.v3', workflow };
  }
  private readSchedule(id: string): Schedule | null {
    const row = this.database.prepare('SELECT schedule_json FROM productivity_schedules WHERE schedule_id=?').get(id) as ScheduleRow | undefined;
    return row === undefined ? null : parseSchedule(row);
  }
  private requireSchedule(id: string, workspaceId: string, sessionId: string): Schedule {
    const schedule = this.readSchedule(id);
    if (schedule === null || schedule.workspaceId !== workspaceId || schedule.sessionId !== sessionId) throw new Error('schedule_not_found');
    return schedule;
  }
  private writeSchedule(schedule: Schedule, now: string): void {
    this.database.prepare(`INSERT INTO productivity_schedules(schedule_id,workspace_id,session_id,version,status,next_fire_at,schedule_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET version=excluded.version,status=excluded.status,next_fire_at=excluded.next_fire_at,schedule_json=excluded.schedule_json,updated_at=excluded.updated_at`).run(schedule.scheduleId, schedule.workspaceId, schedule.sessionId, schedule.version, schedule.status, schedule.nextFireAt, JSON.stringify(schedule), now, now);
  }
}

function initializeSchema(database: DatabaseSync): void {
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version !== 0 && version !== PRODUCTIVITY_DB_SCHEMA_VERSION) throw new Error(`productivity_offline_migration_required:${String(version)}:1`);
  if (version === 1) return;
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE productivity_goals(goal_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,goal_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX productivity_goal_session ON productivity_goals(workspace_id,session_id);
    CREATE TABLE productivity_todo_snapshots(goal_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,items_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE productivity_workflows(workflow_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,workflow_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE productivity_schedules(schedule_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,next_fire_at TEXT,schedule_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX productivity_schedule_due ON productivity_schedules(status,next_fire_at);
    CREATE TABLE productivity_schedule_occurrences(occurrence_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,prompt TEXT NOT NULL,due_at TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempts INTEGER NOT NULL,last_error TEXT);
    CREATE TABLE productivity_commands(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,committed_at TEXT NOT NULL);
    CREATE TABLE productivity_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,kind TEXT NOT NULL,event_json TEXT NOT NULL,occurred_at TEXT NOT NULL);
    PRAGMA user_version=1;
    COMMIT;
  `);
}

function firstFire(timing: Schedule['timing'], now: Date): string {
  if (timing.kind === 'once') return timing.at;
  if (timing.kind === 'interval') return new Date(now.getTime() + timing.intervalMs).toISOString();
  const next = new Cron(timing.expression, { timezone: timing.timezone, paused: true }).nextRun(now);
  if (next === null) throw new Error('schedule_cron_has_no_next_run');
  return next.toISOString();
}
function nextSchedule(schedule: Schedule, now: Date): Schedule {
  if (schedule.timing.kind === 'once') return { ...schedule, version: schedule.version + 1, status: 'completed', nextFireAt: null, fireCount: schedule.fireCount + 1 };
  return { ...schedule, version: schedule.version + 1, nextFireAt: firstFire(schedule.timing, now), fireCount: schedule.fireCount + 1 };
}
function parseSchedule(row: ScheduleRow): Schedule { return JSON.parse(row.schedule_json) as Schedule; }
function digestJson(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function stableId(...parts: string[]): string { return `id-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`; }
function canonicalDate(value: Date): string { if (!Number.isFinite(value.getTime())) throw new Error('productivity_clock_invalid'); return value.toISOString(); }
