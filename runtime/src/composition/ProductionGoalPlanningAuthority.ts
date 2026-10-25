import type { AgentRun, AgentEffectExecutionInput } from '@ariadne/agent-core';
import type { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { digestConversationMessagePayload } from '../conversation/ConversationAuthority.js';
import type { GoalPlanningAuthority } from '../control/ports/GoalPlanningAuthority.js';
import { goalDecisionSchema } from '@ariadne/protocol/host';
import { renderProductivityTaskPrompt } from '../conversation/ProductivityTaskPrompt.js';
import type { AgentProtectedEffectResultAuthority } from '../control/ports/AgentToolExecution.js';
import { historicalProviderToolCallId } from '../adapters/model/AgentModelToolResultReference.js';

/** Binds one protected Goal Tool invocation to the exact durable planner objective and Effect. */
export class ProductionGoalPlanningAuthority implements GoalPlanningAuthority {
  public constructor(private readonly store: SqliteProductivityStore,
    private readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    private readonly loadRun: (runId: string) => Promise<AgentRun | null>,
    private readonly loadEffectInput: (runId: string, effectId: string) => Promise<AgentEffectExecutionInput>,
    private readonly results: AgentProtectedEffectResultAuthority) {}

  public async stageDecision(input: Parameters<GoalPlanningAuthority['stageDecision']>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    const decision = goalDecisionSchema.parse(input.decision);
    const run = await this.loadRun(input.runId);
    if (run === null || run.runId !== input.runId || run.binding.objectiveRef.kind !== 'conversation_message'
      || run.binding.objectiveRef.messageVersion !== 1) throw new Error('goal_planner_run_not_authorized');
    const objective = run.binding.objectiveRef;
    const bound = await this.store.findGoalPlannerTask(run.binding.sessionId, objective.messageId);
    if (bound === null || bound.goal.workspaceId !== run.binding.workspace.workspaceId
      || (bound.task.runId !== undefined && bound.task.runId !== run.runId)) throw new Error('goal_planner_run_not_authorized');
    const effect = run.effects.find(item => item.effectId === input.effectId);
    if (effect === undefined || effect.runId !== input.runId || effect.tool.toolName !== 'productivity.record_goal_decision'
      || effect.idempotencyKey !== input.idempotencyKey || effect.scope.length !== 1 || effect.scope[0] !== bound.goal.workspaceId
      || !['started', 'uncertain', 'succeeded'].includes(effect.state.status)) throw new Error('goal_planner_effect_not_authorized');
    const protectedInput = await this.loadEffectInput(run.runId, effect.effectId);
    if (protectedInput.runId !== run.runId || protectedInput.effectId !== effect.effectId || protectedInput.inputDigest !== effect.inputDigest
      || JSON.stringify(goalDecisionSchema.parse(protectedInput.input)) !== JSON.stringify(decision)) throw new Error('goal_planner_effect_input_conflict');
    const message = await this.conversation.readMessageVersion(objective.messageId, 1);
    const expectedDigest = await digestConversationMessagePayload({
      content: await renderProductivityTaskPrompt(this.conversation, bound.goal.workspaceId, bound.task), execution: { mode: 'agent' }
    });
    if (message === null || message.role !== 'user' || message.sessionId !== bound.task.sessionId
      || message.workspaceId !== bound.goal.workspaceId || message.payload.execution?.mode !== 'agent'
      || message.contentDigest !== expectedDigest || objective.contentDigest !== expectedDigest) throw new Error('goal_planner_objective_conflict');
    if (decision.decision === 'complete') {
      const seen = new Set<string>();
      for (const check of decision.checks) for (const source of check.sources) {
        const key = JSON.stringify(source); if (seen.has(key)) continue; seen.add(key);
        if (source.kind === 'task_result') {
          const dependency = bound.task.dependencyMessages?.find(item => item.reference.messageId === source.messageId);
          if (dependency === undefined) throw new Error('goal_completion_evidence_not_authorized');
          const result = await this.conversation.resolveMessageReference(dependency.reference);
          if (result.workspaceId !== bound.goal.workspaceId || result.role !== 'assistant') throw new Error('goal_completion_evidence_not_authorized');
        } else {
          const sourceEffect = run.effects.find(item => historicalProviderToolCallId(run.runId, item.effectId, item.toolCallId) === source.toolCallId);
          if (sourceEffect === undefined || sourceEffect.effectId === effect.effectId || sourceEffect.state.status !== 'succeeded'
            || sourceEffect.tool.toolName === 'productivity.record_goal_decision' || !sourceEffect.scope.includes(bound.goal.workspaceId)) {
            throw new Error('goal_completion_evidence_not_authorized');
          }
          const result = await this.results.loadProtectedEffectResultAuthority(run.runId, sourceEffect.effectId);
          if (result === null || result.runId !== run.runId || result.workspaceId !== bound.goal.workspaceId
            || result.effectId !== sourceEffect.effectId || result.toolCallId !== sourceEffect.toolCallId
            || result.status !== 'succeeded' || JSON.stringify(result.tool) !== JSON.stringify(sourceEffect.tool)) {
            throw new Error('goal_completion_evidence_not_authorized');
          }
        }
      }
    }
    signal.throwIfAborted();
    return this.store.stageGoalDecision(bound.goal.goalId, bound.task.attempt, { ...input, decision });
  }
}
