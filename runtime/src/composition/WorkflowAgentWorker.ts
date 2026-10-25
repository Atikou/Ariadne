import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import type { AgentRun } from '@ariadne/agent-core';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { WorkflowAgentTask, WorkflowAgentWork } from '../adapters/persistence/SqliteWorkflowExecution.js';
import { workflowIdFor } from '../adapters/persistence/SqliteWorkflowExecution.js';
import { submitProductivityTask, sendProductivityTaskCommand } from './ProductivityAgentTask.js';
import { deriveConversationAuthorityId } from '../conversation/ConversationRunHandoffIds.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import { ProductivityTaskInvariantError } from '../control/ports/ProductivityTaskIsolationV1.js';
import { withWorkflowTaskCriteria } from '../conversation/ProductivityTaskPrompt.js';

/** Consumes durable Todo intents through ordinary Conversation and Run command owners. */
export class WorkflowAgentWorker {
  private stopped = true;
  private active: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | null = null;
  private failure: unknown;
  private quarantinedTasks = 0;
  public hasQuarantinedTasks(): boolean { return this.quarantinedTasks > 0; }

  public constructor(
    private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>,
    private readonly dispatch: (envelope: RuntimeCommandEnvelope) => Promise<RuntimeApplicationCommandResult | null>,
    private readonly intervalMs = 1_000
  ) {}

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
    this.active ??= this.runOnce().finally(() => { this.active = null; });
    return this.active;
  }
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort(new Error('workflow_worker_stopped'));
    await this.active;
  }
  private fail(error: unknown): void {
    this.failure = error; this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async runOnce(): Promise<void> {
    this.quarantinedTasks = await this.store.countQuarantinedTasks('workflow');
    await this.store.materializeDue();
    const controller = new AbortController();
    this.controller = controller;
    try {
      for (const work of await this.store.pendingWorkflowAgentWork()) {
        for (const snapshot of work.workflow.agentExecution!.tasks) {
          if (this.stopped) return;
          if (snapshot.status === 'terminal' || await this.store.isTaskQuarantined('workflow', work.workflow.workflowId, snapshot.todoId)) continue;
          try {
          const task = snapshot.status === 'unclaimed'
            ? await this.store.claimWorkflowAgentTask(work.workflow.workflowId, snapshot.todoId) : snapshot;
          if (task === null) continue;
          // Refresh before every boundary: cancellation may have arrived during another task's dispatch.
          const current = (await this.store.pendingWorkflowAgentWork()).find(item => item.workflow.workflowId === work.workflow.workflowId);
          if (current === undefined) throw new ProductivityTaskInvariantError('task_authority_conflict');
          await this.processTask(current, task, controller.signal);
          } catch (error) {
            if (!(error instanceof ProductivityTaskInvariantError)) throw error;
            await this.store.quarantineTask('workflow', work.workflow.workflowId, snapshot.todoId, error.code);
            this.quarantinedTasks = await this.store.countQuarantinedTasks('workflow');
          }
        }
      }
    } catch (error) {
      if (!this.stopped || !controller.signal.aborted || error !== controller.signal.reason) throw error;
    }
    finally { this.controller = null; }
  }
  private async processTask(work: WorkflowAgentWork, task: WorkflowAgentTask, signal: AbortSignal): Promise<void> {
    const workflowId = work.workflow.workflowId;
    if (task.status === 'claimed') {
      if (!await this.submit(work, task, signal)) return;
      await this.store.recordWorkflowAgentSubmission(workflowId, task.todoId);
    }
    const saga = await this.conversation.readSagaByMessage(task.messageId, 1);
    if (saga === null || saga.sessionId !== task.sessionId || saga.workspaceId !== work.workspaceId)
      throw new ProductivityTaskInvariantError('submission_identity_conflict');
    if (saga.stage.kind === 'agent_start_failed') {
      await this.store.settleWorkflowAgentTask(workflowId, task.todoId, 'failed', 'Agent Run 未能启动。'); return;
    }
    if (saga.stage.kind !== 'agent_run_linked' && saga.stage.kind !== 'agent_result_projected') return;
    if (task.runId !== undefined && task.runId !== saga.stage.runId) throw new ProductivityTaskInvariantError('task_authority_conflict');
    await this.store.recordWorkflowAgentSubmission(workflowId, task.todoId, saga.stage.runId);
    const run = await this.loadRun(saga.stage.runId);
    if (run === null || run.runId !== saga.stage.runId || run.binding.workspace.workspaceId !== work.workspaceId || run.binding.sessionId !== task.sessionId) {
      throw new ProductivityTaskInvariantError('task_authority_conflict');
    }
    if (run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageId !== task.messageId || run.binding.objectiveRef.messageVersion !== 1
      || run.binding.objectiveRef.contentDigest !== saga.objectiveDigest) throw new ProductivityTaskInvariantError('task_authority_conflict');
    if (run.state.status === 'completed' || run.state.status === 'failed' || run.state.status === 'cancelled') {
      let resultMessage;
      if (run.state.status === 'completed') {
        if (saga.stage.kind !== 'agent_result_projected') return;
        if (saga.stage.resultStatus !== 'completed' || saga.stage.resultRunVersion !== run.version) {
          throw new ProductivityTaskInvariantError('result_authority_conflict');
        }
        const messageId = await deriveConversationAuthorityId('agent-result-message', saga.stage.sourceRunEventId);
        const message = await this.conversation.readMessageVersion(messageId, 1);
        if (message === null || message.sessionId !== task.sessionId || message.workspaceId !== work.workspaceId
          || message.role !== 'assistant') throw new ProductivityTaskInvariantError('result_authority_conflict');
        resultMessage = { sessionId: message.sessionId, messageId, messageVersion: message.version, contentDigest: message.contentDigest };
      }
      // Terminal Core authority proves join. Private payloads and exception messages remain outside this DTO.
      await this.store.settleWorkflowAgentTask(workflowId, task.todoId, run.state.status,
        run.state.status === 'completed' ? 'Agent Run 已完成，可打开任务会话查看结果。'
          : run.state.status === 'failed' ? 'Agent Run 执行失败，可打开任务会话查看详情。' : 'Agent Run 已确认结束。',
        new Date(), { runId: run.runId, runVersion: run.version, ...(resultMessage === undefined ? {} : { resultMessage }) });
      return;
    }
    const latest = (await this.store.pendingWorkflowAgentWork()).find(item => item.workflow.workflowId === workflowId);
    if (latest?.workflow.status !== 'cancelling') return;
    const result = await this.send(workflowIdFor('cancel', workflowId, task.todoId, String(run.version)), {
      kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: run.runId, expectedVersion: run.version, occurredAt: run.updatedAt, reason: 'user_requested'
    }, signal);
    if (result === null || result.settlement !== 'completed') return;
    if (!result.outcome.ok && result.outcome.error.code !== 'agent_run_version_conflict') {
      throw new ProductivityTaskInvariantError('cancellation_rejected');
    }
    // A requested receipt is never a terminal task result; the next scan checks actual Run authority.
  }
  private async submit(work: WorkflowAgentWork, task: WorkflowAgentTask, signal: AbortSignal): Promise<boolean> {
    const criteria = work.workflow.agentExecution!.criteria;
    const submittedTask = withWorkflowTaskCriteria(task, criteria);
    const result = await submitProductivityTask({ conversation: this.conversation, dispatch: this.dispatch,
      workspaceId: work.workspaceId, context: work.workflow.agentExecution!.context, task: submittedTask, signal });
    if (result === 'rejected') {
      await this.store.settleWorkflowAgentTask(work.workflow.workflowId, task.todoId, 'failed', '任务提交被拒绝，尚未创建 Agent Run。');
    }
    return result === 'accepted';
  }
  private send(commandId: string, command: RuntimeCommandEnvelope['command'], signal: AbortSignal): Promise<RuntimeApplicationCommandResult | null> {
    return sendProductivityTaskCommand(this.dispatch, commandId, command, signal);
  }
}
