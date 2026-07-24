import { z } from "zod";

import { JsonValueSchema } from "../core/jsonContracts.js";

const id = z.string().trim().min(1).max(512);
const text = z.string();
const shortText = z.string().trim().min(1).max(4_096);
const timestamp = z.string().trim().min(1).max(128);
const nonNegativeInteger = z.number().int().nonnegative();

export const ContextPhaseSchema = z.enum(["pre_call", "post_call"]);
export const MemoryScopeSchema = z.enum(["global", "session", "project", "task"]);
export const MemoryTypeSchema = z.enum([
  "preference",
  "habit",
  "decision",
  "fact",
  "lesson",
  "project_note",
  "recent_state",
  "task_state",
  "known_issue",
  "tech_stack",
]);

export const ContextSessionCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    projectId: id.optional(),
    workspaceKey: id.optional(),
    workspaceRoot: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workspaceKey && value.workspaceRoot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceRoot"],
        message: "workspaceKey and workspaceRoot are mutually exclusive",
      });
    }
  });

export const ContextSessionUpdateRequestSchema = z
  .object({ title: z.string().trim().min(1).max(500) })
  .strict();

export const ContextMemoryCreateRequestSchema = z
  .object({
    scope: MemoryScopeSchema,
    scopeId: id.optional(),
    memoryType: MemoryTypeSchema,
    key: z.string().max(1_024).optional(),
    value: z.string().trim().min(1).max(100_000),
    summary: z.string().max(20_000).optional(),
    importance: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const ContextMemoryDeactivateRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_024).optional() })
  .strict();

export const ContextSessionPurgeRequestSchema = z
  .object({ confirm: z.boolean().optional() })
  .strict();

export const ContextNoQuerySchema = z.object({}).strict();

export const ContextSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(20_000),
    scope: MemoryScopeSchema.optional(),
    scopeId: id.optional(),
    tags: z.string().max(10_000).optional(),
  })
  .strict();

export const ContextProjectIndexQuerySchema = z
  .object({ projectId: id.optional().transform((value) => value ?? "default") })
  .strict();

export const ContextMemoriesQuerySchema = z
  .object({ scope: MemoryScopeSchema.optional(), scopeId: id.optional() })
  .strict();

export const ContextRestoreQuerySchema = z
  .object({
    q: z.string().max(100_000).optional(),
    phase: ContextPhaseSchema.optional().transform((value) => value ?? "pre_call"),
  })
  .strict();

export const ContextSessionSchema = z
  .object({
    id,
    title: text,
    status: z.enum(["active", "archived"]),
    projectId: id.optional(),
    workspaceKey: id.optional(),
    lastMessageId: id.optional(),
    activeTaskId: id.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const ContextToolCallSchema = z
  .object({ id, name: shortText, arguments: JsonValueSchema })
  .strict();

const MessageKindSchema = z.enum([
  "user_input",
  "tool_action",
  "conversational_reply",
  "final_answer",
  "raw_model_final",
  "tool_result",
  "workflow_event",
  "guard_notice",
]);

const MessageSourceSchema = z.enum(["user", "model", "guard", "tool", "workflow", "system"]);
const MessageTrustBasisSchema = z.enum([
  "user_authored",
  "conversational_reply",
  "completion_guard",
  "tool_ledger",
]);

export const ContextMessageRecordSchema = z
  .object({
    id,
    sessionId: id,
    role: text,
    content: text,
    tokenEstimate: nonNegativeInteger,
    isSummarized: z.boolean(),
    summaryId: id.optional(),
    clientName: text.optional(),
    modelName: text.optional(),
    messageKind: MessageKindSchema.optional(),
    uiVisible: z.boolean().optional(),
    trusted: z.boolean().optional(),
    source: MessageSourceSchema.optional(),
    trustBasis: MessageTrustBasisSchema.optional(),
    runId: id.optional(),
    ledgerBacked: z.boolean().optional(),
    outcomeClass: text.optional(),
    outcomeKind: text.optional(),
    toolName: text.optional(),
    toolCallId: id.optional(),
    toolCalls: z.array(ContextToolCallSchema).optional(),
    createdAt: timestamp,
  })
  .strict();

export const ContextStructuredSummarySchema = z
  .object({
    current_goal: text.optional(),
    important_decisions: z.array(text).optional(),
    user_preferences: z.array(text).optional(),
    project_state: z.array(text).optional(),
    open_questions: z.array(text).optional(),
    recent_changes: z.array(text).optional(),
    important_files: z.array(text).optional(),
    tool_results: z.array(text).optional(),
    errors_seen: z.array(text).optional(),
  })
  .strict();

export const ContextSummarySchema = z
  .object({
    id,
    sessionId: id,
    projectId: id.optional(),
    summaryType: z.enum(["chunk_summary", "session_summary", "daily_summary", "task_summary"]),
    content: ContextStructuredSummarySchema,
    contentText: text,
    startMessageId: id.optional(),
    endMessageId: id.optional(),
    tokenCount: nonNegativeInteger,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const ContextMemorySchema = z
  .object({
    id,
    scope: MemoryScopeSchema,
    scopeId: id.optional(),
    memoryType: MemoryTypeSchema,
    key: text.optional(),
    value: text,
    summary: text.optional(),
    importance: z.number().finite(),
    confidence: z.number().finite(),
    source: text.optional(),
    sourceId: id.optional(),
    isActive: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    supersedesId: id.optional(),
  })
  .strict();

const ContextProjectSchema = z
  .object({
    id,
    name: text,
    rootPath: text.optional(),
    description: text.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const ContextTaskSchema = z
  .object({
    id,
    sessionId: id.optional(),
    projectId: id.optional(),
    goal: text,
    status: text,
    summary: text.optional(),
    inputs: z.array(text).optional(),
    outputs: z.array(text).optional(),
    acceptanceCriteria: z.array(text).optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const ContextSystemSectionItemSchema = z
  .object({
    sourceType: z.enum(["memory", "summary", "project", "task", "semantic", "tool", "file"]),
    sourceId: id.optional(),
    text,
    score: z.number().finite().optional(),
    tags: z.array(text).optional(),
  })
  .strict();

const ContextSystemSectionTypeSchema = z.enum([
  "user_preferences",
  "session_summary",
  "context_corrections",
  "task_state",
  "current_plan",
  "file_snippets",
  "project_context",
  "relevant_memories",
  "semantic_results",
  "recent_tool_results",
  "response_rules",
]);

const ContextSystemSectionSchema = z
  .object({
    type: ContextSystemSectionTypeSchema,
    title: text,
    priority: z.number().finite(),
    items: z.array(ContextSystemSectionItemSchema),
  })
  .strict();

const ContextTaggedFragmentSchema = z
  .object({
    id,
    tags: z.array(text),
    sourceType: ContextSystemSectionItemSchema.shape.sourceType,
    sourceId: id.optional(),
    sectionType: ContextSystemSectionTypeSchema,
    text,
  })
  .strict();

const ContextMessageSchema = z
  .object({
    id,
    role: z.enum(["user", "assistant", "tool", "system"]),
    content: text,
    createdAt: timestamp,
    messageKind: MessageKindSchema.optional(),
    uiVisible: z.boolean().optional(),
    trusted: z.boolean().optional(),
    source: MessageSourceSchema.optional(),
    trustBasis: MessageTrustBasisSchema.optional(),
    runId: id.optional(),
    toolName: text.optional(),
    toolCallId: id.optional(),
    toolCalls: z.array(ContextToolCallSchema).optional(),
  })
  .strict();

const ContextTrustReasonSchema = z.enum([
  "user_input",
  "trusted_final",
  "trusted_tool_result",
  "protocol_tool_action",
  "guard_notice",
  "filtered_raw_model_final",
  "filtered_tool_action",
  "filtered_untrusted_assistant",
  "filtered_workflow_event",
  "filtered_misleading_completion",
]);

const ContextTrustReportSchema = z
  .object({
    includedCount: nonNegativeInteger,
    excludedCount: nonNegativeInteger,
    excluded: z.array(
      z
        .object({ messageId: id, role: text, reason: ContextTrustReasonSchema, preview: text })
        .strict(),
    ),
    corrections: z.array(text),
  })
  .strict();

const ContextSemanticItemSchema = z
  .object({
    id,
    itemType: z.enum(["chat", "summary", "memory", "document", "image", "screenshot", "code"]),
    scope: MemoryScopeSchema,
    scopeId: id.optional(),
    sourceType: text,
    sourceId: id,
    content: text,
    summary: text.optional(),
    tags: z.array(text).optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const ContextSemanticHitSchema = z
  .object({ item: ContextSemanticItemSchema, score: z.number().finite(), reason: z.literal("semantic") })
  .strict();

const ContextRetrievedMemorySchema = z
  .object({
    memory: ContextMemorySchema,
    score: z.number().finite(),
    reason: z.enum(["fixed_preference", "project_context", "task_context", "fts", "semantic", "recent"]),
    trustLevel: z.enum(["verified", "inferred", "unverified"]).optional(),
    sourceKind: text.optional(),
  })
  .strict();

export const ContextPackageSchema = z
  .object({
    sessionId: id,
    projectId: id.optional(),
    taskId: id.optional(),
    systemSections: z.array(ContextSystemSectionSchema),
    taggedFragments: z.array(ContextTaggedFragmentSchema),
    messages: z.array(ContextMessageSchema),
    summaries: z.array(ContextSummarySchema),
    memories: z.array(ContextRetrievedMemorySchema),
    semanticHits: z.array(ContextSemanticHitSchema),
    projectContext: ContextProjectSchema.optional(),
    activeTask: ContextTaskSchema.optional(),
    contextTrust: ContextTrustReportSchema.optional(),
  })
  .strict();

const ContextChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: text,
    name: text.optional(),
    toolCallId: id.optional(),
    toolCalls: z.array(ContextToolCallSchema).optional(),
  })
  .strict();

export const ContextRenderedPromptSchema = z
  .object({ systemSectionsText: text, finalMessages: z.array(ContextChatMessageSchema) })
  .strict();

export const ContextSearchHitSchema = z
  .object({
    source: z.enum(["fts", "vector"]),
    itemType: text,
    sourceId: id,
    content: text,
    score: z.number().finite(),
    tags: z.array(text).optional(),
  })
  .strict();

export const ContextProjectIndexStatsSchema = z
  .object({
    projectId: id,
    workspaceRoot: text,
    fileCount: nonNegativeInteger,
    symbolCount: nonNegativeInteger,
    lastIndexedAt: timestamp.optional(),
  })
  .strict();

export const ContextSessionsResultSchema = z.object({ sessions: z.array(ContextSessionSchema) }).strict();
export const ContextSessionResultSchema = z.object({ session: ContextSessionSchema }).strict();
export const ContextSessionDetailResultSchema = z
  .object({
    session: ContextSessionSchema,
    messages: z.array(ContextMessageRecordSchema),
    summaries: z.array(ContextSummarySchema),
  })
  .strict();
export const ContextRestoreResultSchema = z
  .object({
    session: ContextSessionSchema,
    phase: ContextPhaseSchema,
    contextPackage: ContextPackageSchema,
    renderedPrompt: ContextRenderedPromptSchema,
  })
  .strict();
export const ContextCompressResultSchema = z
  .object({ compressed: ContextSummarySchema.nullable(), needsCompression: z.boolean() })
  .strict();
export const ContextSearchResultSchema = z
  .object({ hits: z.array(ContextSearchHitSchema), warning: text.optional() })
  .strict();
export const ContextProjectIndexResultSchema = z.object({ stats: ContextProjectIndexStatsSchema }).strict();
export const ContextMemoriesResultSchema = z.object({ memories: z.array(ContextMemorySchema) }).strict();
export const ContextMemoryResultSchema = z.object({ memory: ContextMemorySchema }).strict();
export const ContextMemoryDeactivateResultSchema = z
  .object({ memoryId: id, deactivated: z.literal(true), reason: text })
  .strict();
export const ContextSessionDeleteResultSchema = z
  .object({
    sessionId: id,
    deleted: z.literal(true),
    runIds: z.array(id),
    artifactsBytesFreed: nonNegativeInteger,
  })
  .strict();

const ContextPurgeResultSchema = z
  .object({
    sessionId: id,
    runIds: z.array(id),
    mode: z.literal("purge"),
    trace: z
      .object({
        segmentsRewritten: nonNegativeInteger,
        eventsRemoved: nonNegativeInteger,
        indexEntriesRemoved: nonNegativeInteger,
      })
      .strict(),
    tools: z
      .object({ toolLogsRemoved: nonNegativeInteger, fileChangesRemoved: nonNegativeInteger })
      .strict(),
    routing: z
      .object({
        routeLogsRemoved: nonNegativeInteger,
        callLogsRemoved: nonNegativeInteger,
        collaborationRunsRemoved: nonNegativeInteger,
        fallbackLogsRemoved: nonNegativeInteger,
      })
      .strict(),
    notifications: z.object({ linesRemoved: nonNegativeInteger }).strict(),
    schedulerJournalBytesFreed: nonNegativeInteger,
    artifactsBytesFreed: nonNegativeInteger,
    vacuumed: z.boolean(),
  })
  .strict();

export const ContextSessionPurgeResultSchema = z
  .object({ deleted: z.literal(true), purge: ContextPurgeResultSchema })
  .strict();

export const ContextRequestErrorResultSchema = z
  .object({ error: text, code: z.literal("invalid_request") })
  .strict();
export const ContextQueryErrorResultSchema = z
  .object({ error: text, code: z.literal("CONTEXT_QUERY_INVALID") })
  .strict();
export const ContextSessionNotFoundResultSchema = z
  .object({ error: text, code: z.literal("CONTEXT_SESSION_NOT_FOUND"), sessionId: id })
  .strict();
export const ContextMemoryNotFoundResultSchema = z
  .object({ error: text, code: z.literal("CONTEXT_MEMORY_NOT_FOUND"), memoryId: id })
  .strict();
export const ContextSessionActiveRunResultSchema = z
  .object({ error: text, code: z.literal("CONTEXT_SESSION_ACTIVE_RUN"), sessionId: id })
  .strict();
export const ContextPurgeConfirmResultSchema = z
  .object({ error: text, hint: text, code: z.literal("invalid_request") })
  .strict();
export const ContextPurgeErrorResultSchema = z
  .object({ error: text, code: z.literal("CONTEXT_PURGE_FAILED"), sessionId: id })
  .strict();
export const ContextBadRequestResultSchema = z.union([
  ContextRequestErrorResultSchema,
  ContextQueryErrorResultSchema,
]);
export const ContextPurgeBadRequestResultSchema = z.union([
  ContextRequestErrorResultSchema,
  ContextQueryErrorResultSchema,
  ContextPurgeConfirmResultSchema,
]);
