import type { AgentIntentType } from "./IntentTypes.js";
import { hasProjectScope, hasTargetHint } from "./WorkflowPlanner.js";
import {
  buildWorkflowState,
  isWorkflowReadTool,
  isWorkflowWriteTool,
  type WorkflowStateSnapshot,
} from "./WorkflowStateCenter.js";
import { MAX_WORKFLOW_CORRECTION_ATTEMPTS } from "./WorkflowCorrectionWorkflow.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";

export type WorkflowWriteGatePhase = "write" | "fix";

export interface WorkflowWriteGateInput {
  intent: AgentIntentType;
  goal: string;
  tool: string;
  steps: AgentToolStep[];
  hasProposal?: boolean;
  hasDebugAnalysis?: boolean;
  hasRefactorPlan?: boolean;
  state?: WorkflowStateSnapshot;
}

export interface WorkflowWriteGateResult {
  blocked: boolean;
  phase?: WorkflowWriteGatePhase;
  reason?: string;
  readToolsBeforeWrite: number;
  priorWrites: number;
  state: WorkflowStateSnapshot;
}

export function assessWorkflowWriteGate(input: WorkflowWriteGateInput): WorkflowWriteGateResult {
  const state = input.state ?? buildWorkflowState({
    intent: input.intent,
    steps: input.steps,
    hasProposal: input.hasProposal,
    hasDebugAnalysis: input.hasDebugAnalysis,
    hasRefactorPlan: input.hasRefactorPlan,
    maxCorrectionAttempts: MAX_WORKFLOW_CORRECTION_ATTEMPTS,
  });
  const { readToolsBeforeWrite, priorWrites } = state;

  if (!isWorkflowWriteTool(input.tool)) {
    return { blocked: false, readToolsBeforeWrite, priorWrites, state };
  }

  if (state.correctionLimitReached) {
    return {
      blocked: true,
      reason: "workflow correction limit reached: stop writing and return final with the latest verification failure.",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  if (state.requiresVerificationBeforeNextWrite) {
    return {
      blocked: true,
      reason: "workflow state requires verification before another write-capable tool call.",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  if (priorWrites > 0) {
    return {
      blocked: false,
      phase: input.intent === "debug" ? "fix" : "write",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  if (input.intent === "edit" || input.intent === "generate_file") {
    if (!input.hasProposal) {
      return {
        blocked: true,
        reason: "edit/generate-file workflow requires proposal phase before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    if (requiresReadBeforeWrite(input.intent, input.goal) && readToolsBeforeWrite === 0) {
      return {
        blocked: true,
        reason:
          "proposal phase is not complete: use read/locate tools to gather context before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    return {
      blocked: false,
      phase: "write",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  if (input.intent === "debug") {
    if (!input.hasDebugAnalysis) {
      return {
        blocked: true,
        reason: "debug workflow requires analysis phase before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    if (readToolsBeforeWrite === 0) {
      return {
        blocked: true,
        reason:
          "debug analysis is not complete: use read/locate tools to confirm root cause before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    return {
      blocked: false,
      phase: "fix",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  if (input.intent === "refactor") {
    if (!input.hasRefactorPlan) {
      return {
        blocked: true,
        reason: "refactor workflow requires staged plan phase before the first write-capable tool.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    if (readToolsBeforeWrite === 0) {
      return {
        blocked: true,
        reason:
          "refactor plan is not complete: use read/locate tools to confirm affected modules before the first staged write.",
        readToolsBeforeWrite,
        priorWrites,
        state,
      };
    }
    return {
      blocked: false,
      phase: "write",
      readToolsBeforeWrite,
      priorWrites,
      state,
    };
  }

  return { blocked: false, readToolsBeforeWrite, priorWrites, state };
}

export function requiresReadBeforeWrite(intent: AgentIntentType, goal: string): boolean {
  if (intent === "generate_file") {
    return hasProjectScope(goal);
  }
  if (intent === "edit" || intent === "debug") return true;
  return false;
}

export function countSuccessfulReadTools(steps: AgentToolStep[]): number {
  return steps.filter((step) => isSuccessfulToolStep(step) && isWorkflowReadTool(step.tool)).length;
}

export function countSuccessfulWrites(steps: AgentToolStep[]): number {
  return steps.filter((step) => isSuccessfulToolStep(step) && isWorkflowWriteTool(step.tool)).length;
}
