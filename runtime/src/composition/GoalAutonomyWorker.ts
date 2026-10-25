import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type { AgentRun } from '@ariadne/agent-core';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { GoalExecutionRecord, GoalPlannerTask } from '../adapters/persistence/SqliteGoalAutonomy.js';
import { workflowIdFor } from '../adapters/persistence/SqliteWorkflowExecution.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { submitProductivityTask, sendProductivityTaskCommand } from './ProductivityAgentTask.js';
import { ProductivityTaskInvariantError } from '../control/ports/ProductivityTaskIsolationV1.js';

/** Drives durable Goal planner intents through existing Conversation, Run and Workflow owners. */
export class GoalAutonomyWorker {
  private stopped = true;
  private active: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | null = null;
  private failure: unknown;
  private quarantinedTasks = 0;
  public hasQuarantinedTasks(): boolean { return this.quarantinedTasks > 0; }
  public constructor(private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>,
    private readonly dispatch: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>,
    private readonly intervalMs = 1_000) {}

  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.assertHealthy(); this.stopped = false;
    try {
      await this.wake();
      if (this.stopped) return;
      this.timer = setInterval(() => { void this.wake().catch(error => this.fail(error)); }, this.intervalMs);
      this.timer.unref?.();
    } catch (error) { this.fail(error); throw error; }
  }
  public assertHealthy(): void { if (this.failure !== undefined) throw this.failure; }
  public wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.active ??= this.runOnce().finally(() => { this.active = null; }); return this.active;
  }
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined; this.controller?.abort(new Error('goal_worker_stopped'));
    await this.active;
  }
  private fail(error: unknown): void {
    this.failure = error; this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async runOnce(): Promise<void> {
    this.quarantinedTasks = await this.store.countQuarantinedTasks('goal');
    const controller = new AbortController(); this.controller = controller;
    try {
      for (const snapshot of await this.store.pendingGoalAutonomy()) {
        if (this.stopped) return;
        const originalTask = snapshot.agentExecution!.tasks.at(-1)!;
        if (await this.store.isTaskQuarantined('goal', snapshot.goalId, originalTask.todoId)) continue;
        try {
        await this.store.pollGoalAutonomy(snapshot.goalId);
        const task = snapshot.agentExecution!.tasks.at(-1)!;
        const latest = await this.store.findGoalPlannerTask(task.sessionId, task.messageId);
        if (latest === null) throw new ProductivityTaskInvariantError('task_authority_conflict');
        // Poll can create a verification attempt or withdraw an unclaimed attempt after a stop.
        const current = latest.goal.agentExecution!.tasks.at(-1)!;
        if (current.status === 'terminal') continue;
        const claimed = current.status === 'unclaimed'
          ? await this.store.claimGoalPlannerTask(snapshot.goalId, current.attempt) : current;
        if (claimed === null) continue;
        const refreshed = await this.store.findGoalPlannerTask(claimed.sessionId, claimed.messageId);
        if (refreshed === null) throw new ProductivityTaskInvariantError('task_authority_conflict');
        await this.process(refreshed.goal, refreshed.task, controller.signal);
        } catch (error) {
          if (!(error instanceof ProductivityTaskInvariantError)) throw error;
          const latest = await this.store.findGoalPlannerTask(originalTask.sessionId, originalTask.messageId);
          if (latest === null) throw error;
          await this.store.quarantineTask('goal', latest.goal.goalId, latest.task.todoId, error.code);
          this.quarantinedTasks = await this.store.countQuarantinedTasks('goal');
        }
      }
    } catch (error) {
      if (!this.stopped || !controller.signal.aborted || error !== controller.signal.reason) throw error;
    } finally { this.controller = null; }
  }
  private async process(goal: GoalExecutionRecord, task: GoalPlannerTask, signal: AbortSignal): Promise<void> {
    if (task.status === 'claimed') {
      const result = await submitProductivityTask({ conversation: this.conversation, dispatch: this.dispatch,
        workspaceId: goal.workspaceId, context: goal.agentExecution!.context, task, signal });
      if (result === 'uncertain') return;
      if (result === 'rejected') {
        await this.store.settleGoalPlannerTask(goal.goalId, task.attempt, 'failed'); return;
      }
      await this.store.recordGoalPlannerSubmission(goal.goalId, task.attempt);
    }
    const saga = await this.conversation.readSagaByMessage(task.messageId, 1);
    if (saga === null || saga.sessionId !== task.sessionId || saga.workspaceId !== goal.workspaceId) throw new ProductivityTaskInvariantError('submission_identity_conflict');
    if (saga.stage.kind === 'agent_start_failed') {
      await this.store.settleGoalPlannerTask(goal.goalId, task.attempt, 'failed'); return;
    }
    if (saga.stage.kind !== 'agent_run_linked' && saga.stage.kind !== 'agent_result_projected') return;
    if (task.runId !== undefined && task.runId !== saga.stage.runId) throw new ProductivityTaskInvariantError('task_authority_conflict');
    await this.store.recordGoalPlannerSubmission(goal.goalId, task.attempt, saga.stage.runId);
    const run = await this.loadRun(saga.stage.runId);
    if (run === null || run.runId !== saga.stage.runId || run.binding.workspace.workspaceId !== goal.workspaceId
      || run.binding.sessionId !== task.sessionId || run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageId !== task.messageId || run.binding.objectiveRef.messageVersion !== 1
      || run.binding.objectiveRef.contentDigest !== saga.objectiveDigest) throw new ProductivityTaskInvariantError('task_authority_conflict');
    if (run.state.status === 'completed' || run.state.status === 'failed' || run.state.status === 'cancelled') {
      if (saga.stage.kind !== 'agent_result_projected') return;
      if (saga.stage.resultStatus !== run.state.status || saga.stage.resultRunVersion !== run.version) throw new ProductivityTaskInvariantError('result_authority_conflict');
      const messageId = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
      const message = await this.conversation.readMessageVersion(messageId, 1);
      if (message === null || message.sessionId !== task.sessionId || message.workspaceId !== goal.workspaceId
        || message.role !== 'assistant') throw new ProductivityTaskInvariantError('result_authority_conflict');
      const session = await this.conversation.readSession(task.sessionId);
      if (session === null || session.workspaceId !== goal.workspaceId) throw new ProductivityTaskInvariantError('result_authority_conflict');
      await this.store.settleGoalPlannerTask(goal.goalId, task.attempt, run.state.status, { runId: run.runId, runVersion: run.version,
        sessionVersion: session.version,
        message: { sessionId: message.sessionId, messageId, messageVersion: message.version, contentDigest: message.contentDigest } }); return;
    }
    const latest = await this.store.findGoalPlannerTask(task.sessionId, task.messageId);
    if (latest?.goal.agentExecution?.status !== 'stopping') return;
    const receipt = await sendProductivityTaskCommand(this.dispatch, workflowIdFor('goal-cancel', goal.goalId, task.todoId, String(run.version)), {
      kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, runId: run.runId,
      expectedVersion: run.version, occurredAt: run.updatedAt, reason: 'user_requested'
    }, signal);
    if (receipt === null || receipt.settlement !== 'completed') return;
    if (!receipt.outcome.ok && receipt.outcome.error.code !== 'agent_run_version_conflict') throw new ProductivityTaskInvariantError('cancellation_rejected');
    // Cancellation receipt is only a request. A later exact terminal Run and assistant projection prove settlement.
  }
}
