import type { AgentIntentType } from "./IntentTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { renderToolRecoveryContext, type ToolRecoveryWorkflowInput } from "./recovery/ToolRecoveryPolicy.js";

export interface ToolRecoveryWorkflowResult {
  modelContext: string;
}

/** Workflow 层：按 outcomeKind 注入恢复路线。 */
export class ToolRecoveryWorkflow {
  run(input: ToolRecoveryWorkflowInput): ToolRecoveryWorkflowResult | undefined {
    const modelContext = renderToolRecoveryContext(input);
    if (!modelContext) return undefined;
    return { modelContext };
  }
}

export type { ToolRecoveryWorkflowInput };
