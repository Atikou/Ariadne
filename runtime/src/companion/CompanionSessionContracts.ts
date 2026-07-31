import { z } from "zod";

import { ContentEnvelopeSchema } from "../context/ContextContracts.js";
import { CompanionVectorStatusSchema } from "./CompanionVectorContracts.js";

export const CompanionSessionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  title: z.string(),
  storageRoot: z.string().min(1),
  incognito: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSummaryMessageId: z.string().min(1).optional(),
}).strict();
export type CompanionSession = z.infer<typeof CompanionSessionSchema>;

export const CompanionStorageStatusSchema = z.object({
  storageRoot: z.string().min(1),
  dbPath: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  writable: z.boolean(),
}).strict();
export type CompanionStorageStatus = z.infer<typeof CompanionStorageStatusSchema>;

export const CompanionSessionListResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  sessions: z.array(CompanionSessionSchema),
}).strict();
export type CompanionSessionListResult = z.infer<typeof CompanionSessionListResultSchema>;

export const CompanionSessionCreateResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  session: CompanionSessionSchema,
}).strict();
export type CompanionSessionCreateResult = z.infer<typeof CompanionSessionCreateResultSchema>;

export const CompanionSessionUpdateRequestSchema = z.object({
  storageRoot: z.string().optional(),
  title: z.string().trim().min(1).max(120),
}).strict();
export type CompanionSessionUpdateRequest = z.infer<typeof CompanionSessionUpdateRequestSchema>;

export const CompanionSessionUpdateResultSchema = CompanionSessionCreateResultSchema;
export type CompanionSessionUpdateResult = z.infer<typeof CompanionSessionUpdateResultSchema>;

export const CompanionSessionDeletionStatsSchema = z.object({
  sessionId: z.string().min(1),
  deletedMessages: z.number().int().nonnegative(),
  deletedSummaries: z.number().int().nonnegative(),
  deletedSummaryIds: z.array(z.string().min(1)),
  deletedCandidates: z.number().int().nonnegative(),
  deletedMemoryIds: z.array(z.string().min(1)),
  detachedMemoryIds: z.array(z.string().min(1)),
}).strict();
export type CompanionSessionDeletionStats = z.infer<
  typeof CompanionSessionDeletionStatsSchema
>;

export const CompanionMemoryContextDeletionStatsSchema = z.object({
  deletedCandidates: z.number().int().nonnegative(),
  deletedMemoryIds: z.array(z.string().min(1)),
  detachedMemoryIds: z.array(z.string().min(1)),
}).strict();
export type CompanionMemoryContextDeletionStats = z.infer<
  typeof CompanionMemoryContextDeletionStatsSchema
>;

export const CompanionSessionDeletionPersistenceSchema = z.object({
  primary: CompanionSessionDeletionStatsSchema,
  unrestrictedMemory: CompanionMemoryContextDeletionStatsSchema,
}).strict();
export type CompanionSessionDeletionPersistence = z.infer<
  typeof CompanionSessionDeletionPersistenceSchema
>;

export const CompanionSessionDeleteResultSchema = z.object({
  deleted: z.literal(true),
  sessionId: z.string().min(1),
  storages: z.object({
    primary: CompanionStorageStatusSchema,
    unrestrictedMemory: CompanionStorageStatusSchema,
  }).strict(),
  deletions: CompanionSessionDeletionPersistenceSchema,
  vectors: z.object({
    primary: CompanionVectorStatusSchema,
    unrestrictedMemory: CompanionVectorStatusSchema,
  }).strict(),
}).strict();
export type CompanionSessionDeleteResult = z.infer<
  typeof CompanionSessionDeleteResultSchema
>;

export const CompanionMessageRoleSchema = z.enum(["user", "assistant", "system_summary"]);
export type CompanionMessageRole = z.infer<typeof CompanionMessageRoleSchema>;

export const CompanionMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "interrupted",
  "deleted",
]);
export type CompanionMessageStatus = z.infer<typeof CompanionMessageStatusSchema>;

export const CompanionMessageReasoningSchema = z.object({
  content: z.string(),
  status: z.enum(["streaming", "completed", "interrupted"]),
  source: z.enum(["provider", "summary"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();
export type CompanionMessageReasoning = z.infer<typeof CompanionMessageReasoningSchema>;

export const CompanionMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: CompanionMessageRoleSchema,
  content: z.string(),
  status: CompanionMessageStatusSchema,
  contentEnvelope: ContentEnvelopeSchema,
  memoryEligible: z.boolean(),
  modelName: z.string().optional(),
  clientName: z.string().optional(),
  storageRoot: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reasoning: CompanionMessageReasoningSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CompanionMessage = z.infer<typeof CompanionMessageSchema>;

export const CompanionSummarySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sourceMessageStartId: z.string().min(1),
  sourceMessageEndId: z.string().min(1),
  summary: z.string(),
  topics: z.array(z.string()),
  trustLevel: z.literal("generated"),
  modelName: z.string().optional(),
  createdAt: z.string().datetime(),
}).strict();
export type CompanionSummary = z.infer<typeof CompanionSummarySchema>;

export const CompanionRawOutputStatusSchema = z.object({
  enabled: z.literal(true),
  profile: z.literal("raw_output"),
  productVisible: z.literal(true),
  safetyRewrite: z.literal(false),
}).strict();
export type CompanionRawOutputStatus = z.infer<typeof CompanionRawOutputStatusSchema>;

export const CompanionSessionMessagesResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  session: CompanionSessionSchema,
  messages: z.array(CompanionMessageSchema),
  summaries: z.array(CompanionSummarySchema),
  rawOutput: CompanionRawOutputStatusSchema,
}).strict();
export type CompanionSessionMessagesResult = z.infer<typeof CompanionSessionMessagesResultSchema>;

export const CompanionSummaryStatusSchema = z.discriminatedUnion("generated", [
  z.object({
    generated: z.literal(true),
    summaryId: z.string().min(1),
  }).strict(),
  z.object({
    generated: z.literal(false),
    reason: z.string().min(1),
  }).strict(),
]);
export type CompanionSummaryStatus = z.infer<typeof CompanionSummaryStatusSchema>;

export const CompanionSessionSummaryResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  session: CompanionSessionSchema,
  summaryStatus: CompanionSummaryStatusSchema,
  summaries: z.array(CompanionSummarySchema),
}).strict();
export type CompanionSessionSummaryResult = z.infer<typeof CompanionSessionSummaryResultSchema>;
