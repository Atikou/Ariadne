import type { TaskRecord, TaskStepRecord } from "../context/types.js";
import type { Plan, PlanStep, StepStatus } from "./types.js";

export function planFromTask(task: TaskRecord, steps: TaskStepRecord[]): Plan {
  return {
    goal: task.goal,
    scope: { inScope: [], outOfScope: [] },
    risks: [],
    dependencies: [],
    inputs: task.inputs ?? [],
    outputs: task.outputs ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    steps: steps.map(
      (step): PlanStep => ({
        id: step.stepId,
        title: step.title,
        objective: step.objective,
        description: step.description ?? "",
        requiredPermissions: step.requiredPermissions,
        needsConfirmation: step.needsConfirmation,
        acceptance: step.acceptance,
        dependsOn: step.dependsOn ?? [],
        requiredContext: step.requiredContext ?? [],
        availableTools: step.availableTools ?? [],
        expectedArtifacts: step.expectedArtifacts ?? [],
        priority: step.priority ?? 100,
        tool: step.tool,
        toolInput: step.toolInput,
        status: step.status as StepStatus,
        result: step.result,
        error: step.error,
      }),
    ),
  };
}
