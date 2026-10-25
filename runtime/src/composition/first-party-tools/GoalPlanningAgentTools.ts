import { goalDecisionSchema } from '@ariadne/protocol/host';
import type { AgentToolJsonValue } from '@ariadne/agent-core';
import { z } from 'zod';
import type { TrustedAgentToolRegistrationV1 } from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { failed, objectSchema, registration, requireWorkspace, succeeded,
  type WorkspaceBinding } from './FirstPartyAgentToolSupport.js';

/** Publishes the structured, owner-bound decision seam without opening a general productivity write API. */
export function createGoalPlanningAgentToolRegistrations(roots: ReadonlyMap<string, WorkspaceBinding>): readonly TrustedAgentToolRegistrationV1[] {
  return [registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'productivity.record_goal_decision',
    model: {
      description: 'Stage one structured plan, verified completion assessment, or blocked decision for the current autonomous Goal planner Run.',
      guidance: [
        'Only the exact autonomous Goal planning or verification objective is authorized; generic and task-execution Runs cannot write a Goal decision.',
        'Submit one decision, then end this Run with an assistant report. The worker applies it only after the Run actually settles.',
        'A complete assessment must address every numbered criterion, explain observed evidence, and cite actual predecessor messageIds or successful toolCallIds from this Run.',
        'Task titles and summaries become visible Goal/Todo content; include useful instructions and exclude credentials or protected raw Tool payloads.'
      ]
    },
    presentation: { kind: 'generic', label: '提交目标规划与验收决定', resultVisibility: 'protected' },
    capabilityIds: ['workspace.read'], requiredWorkspaceAccess: 'read', sideEffect: 'none', approval: 'never',
    resourceSemantics: 'workspace_resource_id', lifecycleSemantics: 'bounded_invocation',
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(goalDecisionSchema, { target: 'draft-7' }))) as AgentToolJsonValue,
    outputSchema: objectSchema({ staged: { type: 'boolean', const: true }, goalId: { type: 'string' },
      attempt: { type: 'integer', minimum: 1 } }, ['staged', 'goalId', 'attempt']),
    validate: input => {
      const result = goalDecisionSchema.safeParse(input);
      return result.success ? { status: 'accepted', input: result.data } : { status: 'rejected' };
    },
    execute: async (input, context) => {
      try {
        requireWorkspace(roots, context, 'read'); context.signal.throwIfAborted();
        if (context.goalPlanning === undefined) throw new Error('goal_autonomy_unavailable');
        return succeeded(await context.goalPlanning.stageDecision({ runId: context.runId, effectId: context.effectId,
          idempotencyKey: context.idempotencyKey, decision: goalDecisionSchema.parse(input) }, context.signal));
      } catch (error) { return failed('goal_decision_rejected', error); }
    }
  })];
}
