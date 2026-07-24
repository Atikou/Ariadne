import { randomUUID } from "node:crypto";

import type { Planner } from "../agent/Planner.js";
import { finalizePlan } from "../agent/taskGraph.js";
import { bindPlanTools } from "./planToolBinder.js";
import type { Plan, PlanStep } from "../agent/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export interface BuildCorrectionStepsInput {
  failedStep: PlanStep;
  plan: Plan;
  planner?: Planner;
  registry: ToolRegistry;
}

/**
 * 步骤失败时生成 1 条修正步骤（动态 DAG 插入），供 agent_loop + fallbackToPlanOnUncertainty 使用。
 */
export async function buildCorrectionSteps(input: BuildCorrectionStepsInput): Promise<PlanStep[]> {
  const correctionId = `${input.failedStep.id}-correction-${randomUUID().slice(0, 8)}`;
  const context = [
    `失败步骤：${input.failedStep.id} ${input.failedStep.title}`,
    input.failedStep.error ? `错误：${input.failedStep.error}` : "",
    input.failedStep.result ? `输出：${input.failedStep.result.slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let skeleton: Plan;
  if (input.planner) {
    try {
      skeleton = await input.planner.generateExecutablePlan(
        `修正计划步骤：${input.failedStep.title}`,
        context,
      );
      if (skeleton.steps.length > 0) {
        const bound = bindPlanTools(skeleton, { registry: input.registry });
        return bound.steps.slice(0, 2).map((step) => ({
          ...step,
          id: step.id === bound.steps[0]?.id ? correctionId : `${correctionId}-2`,
          dependsOn: [input.failedStep.id],
          status: "pending" as const,
        }));
      }
    } catch {
      // fallback below
    }
  }

  return [
    bindPlanTools(
      finalizePlan({
        goal: input.plan.goal,
        scope: input.plan.scope,
        inputs: input.plan.inputs,
        outputs: input.plan.outputs,
        acceptanceCriteria: input.plan.acceptanceCriteria,
        risks: input.plan.risks,
        dependencies: input.plan.dependencies,
        steps: [
          {
            id: correctionId,
            title: `修正：${input.failedStep.title}`,
            objective: `针对失败步骤 ${input.failedStep.id} 做最小修复`,
            description: input.failedStep.error ?? "重试并验证",
            requiredPermissions: input.failedStep.requiredPermissions,
            needsConfirmation: input.failedStep.needsConfirmation,
            dependsOn: [input.failedStep.id],
            requiredContext: input.failedStep.requiredContext ?? [],
            availableTools: input.failedStep.availableTools ?? ["read_file"],
            expectedArtifacts: [],
            priority: (input.failedStep.priority ?? 100) + 1,
            status: "pending",
          },
        ],
      }),
      { registry: input.registry },
    ).steps[0]!,
  ];
}
