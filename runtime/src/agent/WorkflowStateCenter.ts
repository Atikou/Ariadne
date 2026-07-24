import type { AgentIntentType, AgentWorkflowType } from "./IntentTypes.js";
import type { AgentWorkflowTaskState } from "./RunPolicyTypes.js";
import type { AgentToolStep } from "./toolStep.js";
import { isSuccessfulToolStep } from "./toolStepOutcome.js";

export type WorkflowPhaseState =
  | "idle"
  | "planning"
  | "write_ready"
  | "write_pending_verification"
  | "verification_passed"
  | "correction_allowed"
  | "terminated";

export type WorkflowStateEventType =
  | "planning_recorded"
  | "write_succeeded"
  | "verification_succeeded"
  | "verification_failed"
  | "correction_limit_reached";

export interface WorkflowStateEvent {
  type: WorkflowStateEventType;
  toolCallId?: string;
  tool?: string;
  path?: string;
}

export interface WorkflowStateInput {
  intent: AgentIntentType;
  steps: AgentToolStep[];
  hasProposal?: boolean;
  hasDebugAnalysis?: boolean;
  hasRefactorPlan?: boolean;
  maxCorrectionAttempts: number;
}

export interface WorkflowStateSnapshot {
  workflowType: AgentWorkflowType;
  phase: WorkflowPhaseState;
  taskState: AgentWorkflowTaskState;
  events: WorkflowStateEvent[];
  priorWrites: number;
  readToolsBeforeWrite: number;
  lastWriteToolCallId?: string;
  lastWritePath?: string;
  lastWriteVerified: boolean;
  lastVerificationOk?: boolean;
  failedVerificationAttempts: number;
  maxCorrectionAttempts: number;
  correctionLimitReached: boolean;
  requiresVerificationBeforeNextWrite: boolean;
  planningReady: boolean;
}

export const READ_WORKFLOW_TOOLS = new Set([
  "project_scan",
  "locate_relevant_files",
  "context_pack",
  "read_file",
  "list_files",
  "search_text",
  "symbol_search",
  "diff_file",
  "git_status",
  "git_diff",
]);

const VERIFICATION_TOOLS = new Set([
  "read_file",
  "search_text",
  "diff_file",
  "shell_run",
  "project_index_update",
  "context_pack",
]);

export const WRITE_WORKFLOW_TOOLS = new Set(["write_file", "apply_patch"]);

export function buildWorkflowState(input: WorkflowStateInput): WorkflowStateSnapshot {
  const events: WorkflowStateEvent[] = [];
  const planningReady = isPlanningReady(input);
  if (planningReady) events.push({ type: "planning_recorded" });

  let priorWrites = 0;
  let readToolsBeforeWrite = 0;
  let lastWriteIndex = -1;
  let lastWriteToolCallId: string | undefined;
  let lastWritePath: string | undefined;
  let lastVerificationOk: boolean | undefined;
  let failedVerificationAttempts = 0;

  for (const [index, step] of input.steps.entries()) {
    if (isSuccessfulToolStep(step) && READ_WORKFLOW_TOOLS.has(step.tool) && priorWrites === 0) readToolsBeforeWrite += 1;
    if (isSuccessfulToolStep(step) && WRITE_WORKFLOW_TOOLS.has(step.tool)) {
      priorWrites += 1;
      lastWriteIndex = index;
      lastWriteToolCallId = step.toolCallId;
      lastWritePath = readPath(step);
      lastVerificationOk = undefined;
      events.push({
        type: "write_succeeded",
        tool: step.tool,
        toolCallId: step.toolCallId,
        path: lastWritePath,
      });
      continue;
    }
    if (lastWriteIndex >= 0 && index > lastWriteIndex && VERIFICATION_TOOLS.has(step.tool)) {
      lastVerificationOk = isSuccessfulToolStep(step);
      if (isSuccessfulToolStep(step)) {
        events.push({ type: "verification_succeeded", tool: step.tool, toolCallId: step.toolCallId });
      } else {
        failedVerificationAttempts += 1;
        events.push({ type: "verification_failed", tool: step.tool, toolCallId: step.toolCallId });
      }
    }
  }

  const correctionLimitReached =
    failedVerificationAttempts >= input.maxCorrectionAttempts && lastVerificationOk === false;
  if (correctionLimitReached) events.push({ type: "correction_limit_reached" });

  const lastWriteVerified = priorWrites === 0 || lastVerificationOk !== undefined;
  const requiresVerificationBeforeNextWrite = priorWrites > 0 && lastVerificationOk === undefined;
  const phase = resolvePhase({
    planningReady,
    priorWrites,
    lastVerificationOk,
    correctionLimitReached,
    requiresVerificationBeforeNextWrite,
  });
  return {
    workflowType: workflowTypeForIntent(input.intent),
    phase,
    taskState: taskStateForPhase(phase),
    events,
    priorWrites,
    readToolsBeforeWrite,
    lastWriteToolCallId,
    lastWritePath,
    lastWriteVerified,
    lastVerificationOk,
    failedVerificationAttempts,
    maxCorrectionAttempts: input.maxCorrectionAttempts,
    correctionLimitReached,
    requiresVerificationBeforeNextWrite,
    planningReady,
  };
}

export function isWorkflowReadTool(tool: string): boolean {
  return READ_WORKFLOW_TOOLS.has(tool);
}

export function isWorkflowWriteTool(tool: string): boolean {
  return WRITE_WORKFLOW_TOOLS.has(tool);
}

function isPlanningReady(input: WorkflowStateInput): boolean {
  if (input.intent === "edit" || input.intent === "generate_file") return input.hasProposal === true;
  if (input.intent === "debug") return input.hasDebugAnalysis === true;
  if (input.intent === "refactor") return input.hasRefactorPlan === true;
  return false;
}

function resolvePhase(input: {
  planningReady: boolean;
  priorWrites: number;
  lastVerificationOk?: boolean;
  correctionLimitReached: boolean;
  requiresVerificationBeforeNextWrite: boolean;
}): WorkflowPhaseState {
  if (input.correctionLimitReached) return "terminated";
  if (input.requiresVerificationBeforeNextWrite) return "write_pending_verification";
  if (input.lastVerificationOk === false) return "correction_allowed";
  if (input.lastVerificationOk === true) return "verification_passed";
  if (input.priorWrites > 0) return "write_pending_verification";
  if (input.planningReady) return "write_ready";
  return "planning";
}

function taskStateForPhase(phase: WorkflowPhaseState): AgentWorkflowTaskState {
  if (phase === "planning" || phase === "write_ready") return "planning";
  if (phase === "write_pending_verification") return "verifying";
  if (phase === "verification_passed") return "completed";
  if (phase === "correction_allowed") return "verifying";
  if (phase === "terminated") return "failed";
  return "idle";
}

function readPath(step: AgentToolStep): string | undefined {
  const output = asRecord(step.resultLayers?.raw) ?? asRecord(step.output) ?? {};
  const path = output.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workflowTypeForIntent(intent: AgentIntentType): AgentWorkflowType {
  if (intent === "generate_file") return "generateFileWorkflow";
  if (intent === "debug") return "debugWorkflow";
  if (intent === "refactor") return "refactorWorkflow";
  if (intent === "plan") return "planWorkflow";
  if (intent === "run") return "runWorkflow";
  if (intent === "verify") return "verifyWorkflow";
  if (intent === "review") return "reviewWorkflow";
  if (intent === "summarize") return "summarizeWorkflow";
  if (intent === "search") return "searchWorkflow";
  if (intent === "edit") return "editWorkflow";
  return "answerWorkflow";
}
