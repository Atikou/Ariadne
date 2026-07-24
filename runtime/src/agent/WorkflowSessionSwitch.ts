import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { AgentWorkflowSwitch, AgentWorkflowTaskState } from "./RunPolicyTypes.js";

/** @deprecated 使用 TaskContext；仅 workflow switch 比较所需字段。 */
export interface WorkflowSessionSnapshot {
  sessionId: string;
  intent: AgentIntentType;
  workflowType: AgentWorkflowType;
  workflowTaskState?: AgentWorkflowTaskState;
  runId?: string;
  updatedAt?: string;
}

export interface ResolveWorkflowSwitchInput {
  previous?: WorkflowSessionSnapshot;
  current: {
    intent: AgentIntentType;
    workflowType: AgentWorkflowType;
  };
}

export function resolveWorkflowSwitch(input: ResolveWorkflowSwitchInput): AgentWorkflowSwitch | undefined {
  const { previous, current } = input;
  if (!previous) return undefined;
  if (previous.intent === current.intent && previous.workflowType === current.workflowType) {
    return undefined;
  }
  return {
    switched: true,
    fromIntent: previous.intent,
    toIntent: current.intent,
    fromWorkflowType: previous.workflowType,
    toWorkflowType: current.workflowType,
    fromTaskState: previous.workflowTaskState,
    sequence: 1,
  };
}

export function renderWorkflowSwitchContext(workflowSwitch: AgentWorkflowSwitch): string {
  const from = `${workflowSwitch.fromWorkflowType} (${workflowSwitch.fromIntent})`;
  const to = `${workflowSwitch.toWorkflowType} (${workflowSwitch.toIntent})`;
  const priorState = workflowSwitch.fromTaskState ? ` prior task state=${workflowSwitch.fromTaskState};` : "";
  return [
    "[Workflow switched within session]",
    `Previous workflow: ${from};${priorState}`,
    `Current workflow: ${to}.`,
    "Continue from the conversation context above. Re-evaluate tools, permissions, and workflow phases for the new intent.",
    "Do not assume previous workflow constraints still apply.",
  ].join("\n");
}
