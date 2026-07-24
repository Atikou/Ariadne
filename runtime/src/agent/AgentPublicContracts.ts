import { z } from "zod";

import { AgentNotificationSchema } from "../background/NotificationContracts.js";
import { CompanionAgentResultDeliverySchema } from "../companion/CompanionAgentResultContracts.js";
import { JsonValueSchema } from "../core/jsonContracts.js";
import { PermissionRequestPayloadSchema } from "../policy/permissionRequestTypes.js";
import { PlanHandoffPayloadSchema } from "../policy/planHandoffTypes.js";

const identifier = z.string().trim().min(1).max(512);
const text = z.string();
const nonNegativeInteger = z.number().int().nonnegative();
const jsonObject = z.record(JsonValueSchema);

export const AgentRunModeSchema = z.enum(["chat", "plan", "implement", "debug", "review"]);
export const AgentIntentSchema = z.enum([
  "answer",
  "plan",
  "edit",
  "run",
  "debug",
  "review",
  "verify",
  "summarize",
  "search",
  "refactor",
  "generate_file",
]);
export const AgentWorkflowTypeSchema = z.enum([
  "answerWorkflow",
  "planWorkflow",
  "editWorkflow",
  "runWorkflow",
  "debugWorkflow",
  "reviewWorkflow",
  "verifyWorkflow",
  "summarizeWorkflow",
  "searchWorkflow",
  "refactorWorkflow",
  "generateFileWorkflow",
]);
export const AgentStopReasonSchema = z.enum([
  "completed",
  "completed_partial",
  "recovery_partial",
  "misleading_completion",
  "blocked_by_policy",
  "budget_exhausted",
  "historical_reference",
  "error",
  "user_cancelled",
  "awaiting_permission",
  "awaiting_plan_handoff",
]);
export const AgentRunBudgetSchema = z
  .object({
    maxModelTurns: nonNegativeInteger,
    maxToolCalls: nonNegativeInteger,
    maxReadCalls: nonNegativeInteger,
    maxWriteCalls: nonNegativeInteger,
    maxShellCalls: nonNegativeInteger,
    maxRuntimeMs: nonNegativeInteger,
    maxPreflightTools: nonNegativeInteger,
    maxRecoveryTurns: nonNegativeInteger,
    maxRepeatedToolFailures: nonNegativeInteger,
  })
  .strict();

export const AgentRunBudgetUsageSchema = z
  .object({
    modelTurns: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    attemptedToolCalls: nonNegativeInteger.optional(),
    readCalls: nonNegativeInteger,
    writeCalls: nonNegativeInteger,
    shellCalls: nonNegativeInteger,
    runtimeMs: nonNegativeInteger,
    mainModelTurns: nonNegativeInteger.optional(),
    preflightTools: nonNegativeInteger.optional(),
    recoveryTurns: nonNegativeInteger.optional(),
    cachedToolHits: nonNegativeInteger.optional(),
    toolFailures: nonNegativeInteger.optional(),
    toolObservationFailures: nonNegativeInteger.optional(),
    toolExecutionErrors: nonNegativeInteger.optional(),
  })
  .strict();

const AgentLocationMetaSchema = z
  .object({
    usedLocateSteps: nonNegativeInteger,
    usedSearchCalls: nonNegativeInteger,
    usedListCalls: nonNegativeInteger,
    usedReadForLocationCalls: nonNegativeInteger,
    locatedFiles: z.array(text),
    candidateFiles: z.array(text),
    stopReason: text.optional(),
    needsContinue: z.boolean(),
    confidence: z.number().finite().optional(),
    exploration: z
      .object({
        duplicateCount: nonNegativeInteger,
        newInformationCount: nonNegativeInteger,
        informationGain: z.number().finite(),
        lowYieldLoop: z.boolean(),
      })
      .strict()
      .optional(),
    suggestedAction: z.literal("continue_locating").optional(),
  })
  .strict();

const AgentToolLedgerSchema = z
  .object({
    attemptedReadCalls: nonNegativeInteger,
    blockedReadCalls: nonNegativeInteger,
    successfulReadCalls: nonNegativeInteger,
    attemptedShellCalls: nonNegativeInteger,
    blockedShellCalls: nonNegativeInteger,
    successfulShellCalls: nonNegativeInteger,
    attemptedWriteCalls: nonNegativeInteger,
    blockedWriteCalls: nonNegativeInteger,
    successfulWriteCalls: nonNegativeInteger,
  })
  .strict();

const UserFacingExecutionStateSchema = z.enum([
  "answering",
  "analyzing",
  "planning",
  "waiting_plan_approval",
  "editing",
  "debugging",
  "waiting_tool_permission",
  "verifying",
  "write_gate_blocked",
  "completed",
  "completed_partial",
  "failed",
  "cancelled",
]);

export const AgentExecutionMetaSchema = z
  .object({
    mode: AgentRunModeSchema,
    executionStage: z.enum(["analyze", "plan", "execute", "verify"]).optional(),
    planVariant: z.enum(["plan_only", "plan_wait_approval", "plan_then_execute"]).optional(),
    modeSource: z.enum(["explicit", "inferred"]).optional(),
    intent: AgentIntentSchema.optional(),
    workflowType: AgentWorkflowTypeSchema.optional(),
    permissionPolicy: z
      .enum(["readOnly", "confirmBeforeEdit", "autoEdit", "confirmBeforeRun", "autoRun"])
      .optional(),
    permissionPolicySource: z.enum(["explicit", "inferred"]).optional(),
    workflowProposals: z.array(JsonValueSchema).optional(),
    workflowDiffs: z.array(JsonValueSchema).optional(),
    workflowVerifications: z.array(JsonValueSchema).optional(),
    workflowCorrections: z.array(JsonValueSchema).optional(),
    workflowWritePhases: z.array(JsonValueSchema).optional(),
    workflowDebugFixes: z.array(JsonValueSchema).optional(),
    workflowDebugAnalyses: z.array(JsonValueSchema).optional(),
    workflowRefactorPlans: z.array(JsonValueSchema).optional(),
    workflowInternalPlans: z.array(JsonValueSchema).optional(),
    workflowTaskState: z
      .enum(["idle", "planning", "waiting_confirmation", "executing", "verifying", "completed", "failed", "cancelled"])
      .optional(),
    workflowSwitch: jsonObject.optional(),
    capabilityEscalations: z.array(JsonValueSchema).optional(),
    reconciledWorkflowType: AgentWorkflowTypeSchema.optional(),
    reconciledIntent: AgentIntentSchema.optional(),
    workflowState: jsonObject.optional(),
    budget: AgentRunBudgetSchema,
    usage: AgentRunBudgetUsageSchema,
    budgetExhausted: z
      .enum([
        "maxModelTurns",
        "maxToolCalls",
        "maxReadCalls",
        "maxWriteCalls",
        "maxShellCalls",
        "maxRuntimeMs",
        "maxPreflightTools",
        "maxRecoveryTurns",
        "maxRepeatedToolFailures",
      ])
      .optional(),
    location: AgentLocationMetaSchema.optional(),
    usedIterations: nonNegativeInteger,
    usedModelTurns: nonNegativeInteger,
    usedToolCalls: nonNegativeInteger,
    usedReadCalls: nonNegativeInteger,
    usedWriteCalls: nonNegativeInteger,
    usedShellCalls: nonNegativeInteger,
    stopReason: AgentStopReasonSchema,
    needsMoreBudget: z.boolean(),
    suggestedBudget: AgentRunBudgetSchema.optional(),
    userFacingState: UserFacingExecutionStateSchema.optional(),
    userFacingLabel: text.optional(),
    intentDecisionSource: z
      .enum([
        "explicit_mode",
        "session_continuation",
        "task_continuation",
        "task_boundary",
        "intent_adjudicator",
        "ai_classifier",
        "legacy_fallback",
      ])
      .optional(),
    isContinuation: z.boolean().optional(),
    intentDecisionReason: text.optional(),
    intentDecisionConfidence: z.number().finite().optional(),
    inheritedTaskId: identifier.optional(),
    previousWorkflowType: AgentWorkflowTypeSchema.optional(),
    currentWorkflowType: AgentWorkflowTypeSchema.optional(),
    continuationScore: z.number().finite().optional(),
    continuationSignals: z.record(z.union([z.number().finite(), z.boolean()])).optional(),
    needsWrite: z.boolean().optional(),
    needsShell: z.boolean().optional(),
    requiredSideEffects: z.array(z.enum(["read", "write", "shell"])),
    aiOverridden: z.boolean().optional(),
    boundaryBreakReason: text.optional(),
    effectiveTaskContextId: identifier.optional(),
    legacyIntentHint: AgentIntentSchema.optional(),
    legacyHintSources: z.array(text).optional(),
    entryIntent: AgentIntentSchema.optional(),
    entryWorkflowType: AgentWorkflowTypeSchema.optional(),
    effectiveWorkflowType: AgentWorkflowTypeSchema.optional(),
    suggestedToolCalls: nonNegativeInteger.optional(),
    complexityTier: z.enum(["low", "medium", "high"]).optional(),
    completedSteps: z.array(text).optional(),
    missingSteps: z.array(text).optional(),
    suggestedAction: z.literal("continue_locating").optional(),
    completionStatus: z
      .enum([
        "completed_success",
        "completed_partial",
        "awaiting_permission",
        "blocked_by_policy",
        "misleading_completion",
        "historical_reference",
      ])
      .optional(),
    completionGuardReason: text.optional(),
    completionContract: jsonObject.optional(),
    completionEvidence: jsonObject.optional(),
    guardedAnswer: text.optional(),
    partialSummary: text.optional(),
    toolLedger: AgentToolLedgerSchema.optional(),
    toolLedgerSummary: AgentToolLedgerSchema.optional(),
  })
  .strict();

const AgentToolUserDisplaySchema = z
  .object({
    tool: text,
    truncated: z.boolean(),
    summary: text,
    itemCount: nonNegativeInteger.optional(),
    originalBytes: nonNegativeInteger.optional(),
  })
  .strict();

export const AgentToolStepSchema = z
  .object({
    iteration: nonNegativeInteger,
    toolCallId: identifier.optional(),
    tool: text,
    input: JsonValueSchema,
    permission: z.enum(["read", "write", "shell", "network", "dangerous"]).optional(),
    executed: z.boolean().optional(),
    ok: z.boolean(),
    outcomeClass: z.enum(["execution_error", "observation_failure", "observation_success"]).optional(),
    outcomeKind: text.optional(),
    outcomeMessage: text.optional(),
    outcomePath: text.optional(),
    outcomeCommand: text.optional(),
    outcomeExitCode: z.number().int().optional(),
    suggestedNextActions: z.array(JsonValueSchema).optional(),
    output: JsonValueSchema.optional(),
    recoveryCircuitOpen: z.boolean().optional(),
    resultLayers: z
      .object({
        raw: JsonValueSchema,
        modelVisible: JsonValueSchema,
        userDisplay: AgentToolUserDisplaySchema,
        rawJsonLength: nonNegativeInteger,
        modelJsonLength: nonNegativeInteger,
      })
      .strict()
      .optional(),
    error: text.optional(),
    durationMs: nonNegativeInteger.optional(),
    blocked: z.boolean().optional(),
    cached: z.boolean().optional(),
    systemRecovery: z.boolean().optional(),
    preflight: z.boolean().optional(),
    workflowPhaseBlocked: z.boolean().optional(),
    blockedReasonKind: z.enum(["workflow", "permission", "budget", "policy"]).optional(),
    budgetExhausted: z
      .enum([
        "maxModelTurns",
        "maxToolCalls",
        "maxReadCalls",
        "maxWriteCalls",
        "maxShellCalls",
        "maxRuntimeMs",
        "maxPreflightTools",
        "maxRecoveryTurns",
        "maxRepeatedToolFailures",
      ])
      .optional(),
    risk: jsonObject.optional(),
    confirmationRequest: jsonObject.optional(),
    workspaceAccess: jsonObject.optional(),
    verification: z
      .object({
        kind: z.enum(["write_readback", "tool_success", "artifact_check"]),
        systemAssigned: z.literal(true),
        verifiesToolCallId: identifier.optional(),
        criterionIds: z.array(identifier).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const AgentRouterDecisionSchema = z
  .object({
    id: identifier,
    taskType: text,
    executionStrategy: text,
    selectedModelId: identifier.optional(),
    draftModelId: identifier.optional(),
    reviewModelId: identifier.optional(),
    risk: text,
    reason: text,
    source: text,
    requireUserConfirmation: z.boolean(),
    contextSignals: z.array(text).optional(),
  })
  .strict();

const AgentPromptStrategySchema = z
  .object({
    temperature: z.number().finite(),
    responseStyle: text,
    preferJsonMode: z.boolean(),
    hints: z.array(text),
  })
  .strict();

const RunStateSearchPlanSchema = z
  .object({
    goal: text,
    keywords: z.array(text),
    possibleSymbols: z.array(text),
    possiblePaths: z.array(text),
    exclude: z.array(text),
    taskType: text,
  })
  .strict();

const RunStateLocationSchema = z
  .object({
    projectId: identifier,
    searchPlan: RunStateSearchPlanSchema.optional(),
    visitedFiles: z.array(text),
    visitedDirs: z.array(text),
    candidateFiles: z.array(text),
    primaryFiles: z.array(text),
    indexFileCount: nonNegativeInteger.optional(),
    indexSymbolCount: nonNegativeInteger.optional(),
  })
  .strict();

export const AgentRunStateSchema = z
  .object({
    runId: identifier,
    mode: AgentRunModeSchema,
    goal: text,
    sessionId: identifier.optional(),
    taskId: identifier.optional(),
    status: z.enum(["resumable", "completed"]),
    workflowId: text.optional(),
    completedSteps: z.array(text),
    pendingSteps: z.array(text),
    scannedPaths: z.array(text),
    readFiles: z.array(text),
    toolResultRefs: z.array(
      z
        .object({ tool: text, iteration: nonNegativeInteger, toolCallId: identifier.optional() })
        .strict(),
    ),
    completedToolSteps: z.array(AgentToolStepSchema),
    budgetUsage: AgentRunBudgetUsageSchema,
    stopReason: AgentStopReasonSchema,
    budgetExhausted: AgentExecutionMetaSchema.shape.budgetExhausted,
    updatedAt: z.string().datetime({ offset: true }),
    location: RunStateLocationSchema.optional(),
    intent: AgentIntentSchema.optional(),
    workflowType: AgentWorkflowTypeSchema.optional(),
    permissionPolicy: z
      .enum(["readOnly", "confirmBeforeEdit", "autoEdit", "confirmBeforeRun", "autoRun"])
      .optional(),
    workflowTaskState: AgentExecutionMetaSchema.shape.workflowTaskState,
    workflowInternalPlans: z.array(JsonValueSchema).optional(),
    workflowSwitch: jsonObject.optional(),
    completionCriteria: z.array(JsonValueSchema).optional(),
  })
  .strict();

export const AgentExecutionResultSchema = z
  .object({
    answer: text,
    steps: z.array(AgentToolStepSchema),
    iterations: nonNegativeInteger,
    reachedLimit: z.boolean(),
    awaitingPermission: z.boolean().optional(),
    awaitingPlanHandoff: z.boolean().optional(),
    permissionRequest: PermissionRequestPayloadSchema.optional(),
    planHandoff: PlanHandoffPayloadSchema.optional(),
    executionMeta: AgentExecutionMetaSchema,
    routerDecision: AgentRouterDecisionSchema.optional(),
    promptStrategy: AgentPromptStrategySchema.optional(),
    notifications: z.array(AgentNotificationSchema).optional(),
    sessionId: identifier.optional(),
    compressed: z.boolean().optional(),
    runId: identifier,
    taskId: identifier,
    runState: AgentRunStateSchema.optional(),
    resumed: z.boolean().optional(),
    companionPresentation: CompanionAgentResultDeliverySchema.optional(),
  })
  .strict();

export const AgentErrorResultSchema = z
  .object({
    error: text,
    code: text.optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    kind: text.optional(),
    pendingSteps: z.array(text).optional(),
    permissionRequestId: text.optional(),
    planHandoffId: text.optional(),
    permissionRequest: PermissionRequestPayloadSchema.optional(),
    planHandoff: PlanHandoffPayloadSchema.optional(),
    retryable: z.literal(true).optional(),
    planRunId: text.optional(),
    rollback: jsonObject.optional(),
    companionPresentation: CompanionAgentResultDeliverySchema.optional(),
  })
  .strict();

export const AgentModelTurnEventSchema = z
  .object({
    iteration: nonNegativeInteger,
    phase: z.enum(["started", "completed", "parse_error"]),
    action: z.enum(["tool", "final"]).optional(),
    tool: text.optional(),
    contentPreview: text.optional(),
    clientName: text.optional(),
    modelName: text.optional(),
    latencyMs: nonNegativeInteger.optional(),
  })
  .strict();

export const ActivityRunStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "partial",
  "failed",
  "cancelled",
]);
const ActivityStepStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "warning",
  "failed",
  "skipped",
]);
const ActivityStepTypeSchema = z.enum([
  "analysis",
  "plan",
  "todo",
  "tool_call",
  "file_search",
  "file_read",
  "file_write",
  "file_patch",
  "shell",
  "web_search",
  "validation",
  "summary",
  "error",
  "retry",
  "escalation",
]);

const ActivityRunMetadataSchema = z
  .object({
    userInput: text.optional(),
    projectRoot: text.optional(),
    model: text.optional(),
    mode: text.optional(),
    maxModelTurns: nonNegativeInteger.optional(),
    tags: z.array(text).optional(),
    agentProposalId: identifier.optional(),
    agentGrantId: identifier.optional(),
  })
  .strict();

const ActivityStepMetadataSchema = z
  .object({
    toolName: text.optional(),
    args: jsonObject.optional(),
    resultSummary: text.optional(),
    filePath: text.optional(),
    changedFiles: z.array(text).optional(),
    command: text.optional(),
    exitCode: z.number().int().optional(),
    stdoutPreview: text.optional(),
    stderrPreview: text.optional(),
    errorMessage: text.optional(),
    outcomeClass: text.optional(),
    outcomeKind: text.optional(),
    crossWorkspace: z.boolean().optional(),
    matchedRoot: text.optional(),
    grantId: identifier.optional(),
    pathRisk: text.optional(),
    retryCount: nonNegativeInteger.optional(),
    collapsible: z.boolean().optional(),
    durationMs: nonNegativeInteger.optional(),
  })
  .strict();

export const ActivityAgentStepSchema = z
  .object({
    id: identifier,
    runId: identifier,
    type: ActivityStepTypeSchema,
    title: text,
    content: text.optional(),
    status: ActivityStepStatusSchema,
    startedAt: nonNegativeInteger.optional(),
    endedAt: nonNegativeInteger.optional(),
    metadata: ActivityStepMetadataSchema.optional(),
  })
  .strict();

export const ActivityAgentRunSchema = z
  .object({
    id: identifier,
    title: text,
    goal: text,
    status: ActivityRunStatusSchema,
    steps: z.array(ActivityAgentStepSchema),
    createdAt: nonNegativeInteger,
    updatedAt: nonNegativeInteger,
    startedAt: nonNegativeInteger.optional(),
    endedAt: nonNegativeInteger.optional(),
    metadata: ActivityRunMetadataSchema.optional(),
  })
  .strict();

export const AgentActivityEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), run: ActivityAgentRunSchema }).strict(),
  z.object({ type: z.literal("step_started"), step: ActivityAgentStepSchema }).strict(),
  z
    .object({ type: z.literal("step_delta"), runId: identifier, stepId: identifier, contentDelta: text })
    .strict(),
  z
    .object({
      type: z.literal("step_completed"),
      runId: identifier,
      stepId: identifier,
      result: text.optional(),
      metadata: ActivityStepMetadataSchema.partial().strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("step_failed"),
      runId: identifier,
      stepId: identifier,
      error: text,
      metadata: ActivityStepMetadataSchema.partial().strict().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("step_skipped"), runId: identifier, stepId: identifier, reason: text.optional() })
    .strict(),
  z.object({ type: z.literal("run_completed"), runId: identifier, summary: text }).strict(),
  z.object({ type: z.literal("run_failed"), runId: identifier, error: text }).strict(),
  z.object({ type: z.literal("run_cancelled"), runId: identifier, reason: text.optional() }).strict(),
]);

export const ActivityRunResultSchema = z.object({ run: ActivityAgentRunSchema }).strict();
export const ActivityRunNotFoundResultSchema = z
  .object({ error: text, code: z.literal("ACTIVITY_RUN_NOT_FOUND"), runId: identifier })
  .strict();

export const AgentStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("run_start"), runId: identifier, taskId: identifier, sessionId: identifier.optional() })
    .strict(),
  z.object({ type: z.literal("model_turn"), turn: AgentModelTurnEventSchema }).strict(),
  z
    .object({ type: z.literal("token"), delta: text, iteration: nonNegativeInteger.optional() })
    .strict(),
  z.object({ type: z.literal("step"), step: AgentToolStepSchema }).strict(),
  z.object({ type: z.literal("activity_event"), event: AgentActivityEventSchema }).strict(),
  AgentExecutionResultSchema.extend({ type: z.literal("done") }).strict(),
  AgentErrorResultSchema.extend({
    type: z.literal("error"),
    runId: z.string(),
    taskId: z.string(),
  }).strict(),
]);
