import { z } from "zod";

import {
  CompanionStorageStatusSchema,
  CompanionSummarySchema,
} from "./CompanionSessionContracts.js";
import { CompanionVectorStatusSchema } from "./CompanionVectorContracts.js";

export const CompanionOutputModeSchema = z.enum(["bounded", "unrestricted"]);
export type CompanionOutputMode = z.infer<typeof CompanionOutputModeSchema>;

export const CompanionOutputModeInputSchema = z.enum(["bounded", "unrestricted", "raw"]);
export type CompanionOutputModeInput = z.infer<typeof CompanionOutputModeInputSchema>;

export const CompanionMemoryStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "deleted",
]);
export type CompanionMemoryStatus = z.infer<typeof CompanionMemoryStatusSchema>;

export const CompanionMemoryKindSchema = z.enum([
  "preference",
  "fact",
  "boundary",
  "relationship",
  "style",
]);
export type CompanionMemoryKind = z.infer<typeof CompanionMemoryKindSchema>;

export const CompanionMemorySensitivitySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type CompanionMemorySensitivity = z.infer<
  typeof CompanionMemorySensitivitySchema
>;

export const CompanionMemoryCandidateSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  sourceMessageId: z.string().min(1).optional(),
  kind: CompanionMemoryKindSchema,
  key: z.string().min(1).optional(),
  value: z.string().min(1),
  summary: z.string().min(1),
  status: CompanionMemoryStatusSchema,
  outputMode: CompanionOutputModeSchema,
  reason: z.string().min(1).optional(),
  sensitivity: CompanionMemorySensitivitySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type CompanionMemoryCandidate = z.infer<
  typeof CompanionMemoryCandidateSchema
>;

export const CompanionPendingMemoryCandidateSchema = CompanionMemoryCandidateSchema.extend({
  status: z.literal("candidate"),
});
export type CompanionPendingMemoryCandidate = z.infer<
  typeof CompanionPendingMemoryCandidateSchema
>;

export const CompanionRejectedMemoryCandidateSchema = CompanionMemoryCandidateSchema.extend({
  status: z.literal("rejected"),
});
export type CompanionRejectedMemoryCandidate = z.infer<
  typeof CompanionRejectedMemoryCandidateSchema
>;

export const CompanionConfirmedMemoryCandidateSchema = CompanionMemoryCandidateSchema.extend({
  status: z.literal("confirmed"),
});
export type CompanionConfirmedMemoryCandidate = z.infer<
  typeof CompanionConfirmedMemoryCandidateSchema
>;

export const CompanionMemorySchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  kind: CompanionMemoryKindSchema,
  key: z.string().min(1).optional(),
  value: z.string().min(1),
  summary: z.string().min(1),
  status: CompanionMemoryStatusSchema,
  outputMode: CompanionOutputModeSchema,
  importance: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type CompanionMemory = z.infer<typeof CompanionMemorySchema>;

export const CompanionConfirmedMemorySchema = CompanionMemorySchema.extend({
  status: z.literal("confirmed"),
});
export type CompanionConfirmedMemory = z.infer<
  typeof CompanionConfirmedMemorySchema
>;

export const CompanionMemoryCollectionSchema = z.object({
  candidates: z.array(CompanionPendingMemoryCandidateSchema),
  memories: z.array(CompanionConfirmedMemorySchema),
}).strict();
export type CompanionMemoryCollection = z.infer<
  typeof CompanionMemoryCollectionSchema
>;

const policyBase = {
  sensitivity: CompanionMemorySensitivitySchema,
};

export const CompanionMemoryPolicyBlockedDecisionSchema = z.object({
  allowed: z.literal(false),
  statusDecision: z.literal("blocked"),
  ...policyBase,
  blockedReason: z.string().min(1),
  vectorEligible: z.literal(false),
}).strict();

export const CompanionMemoryPolicyCandidateDecisionSchema = z.object({
  allowed: z.literal(true),
  statusDecision: z.literal("candidate"),
  ...policyBase,
  blockedReason: z.undefined().optional(),
  vectorEligible: z.boolean(),
}).strict();

export const CompanionMemoryPolicyConfirmedDecisionSchema = z.object({
  allowed: z.literal(true),
  statusDecision: z.literal("confirmed"),
  ...policyBase,
  blockedReason: z.undefined().optional(),
  vectorEligible: z.boolean(),
}).strict();

export const CompanionMemoryPolicyDecisionSchema = z.discriminatedUnion(
  "statusDecision",
  [
    CompanionMemoryPolicyBlockedDecisionSchema,
    CompanionMemoryPolicyCandidateDecisionSchema,
    CompanionMemoryPolicyConfirmedDecisionSchema,
  ],
);
export type CompanionMemoryPolicyDecision = z.infer<
  typeof CompanionMemoryPolicyDecisionSchema
>;
export type CompanionMemoryStatusDecision = CompanionMemoryPolicyDecision["statusDecision"];

export const CompanionBoundedMemoryListResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  unrestrictedStorage: z.undefined().optional(),
  candidates: z.array(CompanionPendingMemoryCandidateSchema),
  memories: z.array(CompanionConfirmedMemorySchema),
}).strict();

export const CompanionUnrestrictedMemoryListResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  unrestrictedStorage: CompanionStorageStatusSchema,
  candidates: z.array(CompanionPendingMemoryCandidateSchema),
  memories: z.array(CompanionConfirmedMemorySchema),
}).strict();

export const CompanionMemoryListResultSchema = z.union([
  CompanionBoundedMemoryListResultSchema,
  CompanionUnrestrictedMemoryListResultSchema,
]);
export type CompanionMemoryListResult = z.infer<
  typeof CompanionMemoryListResultSchema
>;

export const CompanionMemoryCreateBlockedResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  candidate: z.undefined().optional(),
  memory: z.undefined().optional(),
  policy: CompanionMemoryPolicyBlockedDecisionSchema,
  vector: z.undefined().optional(),
}).strict();

export const CompanionMemoryCreateCandidateResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  candidate: CompanionPendingMemoryCandidateSchema,
  memory: z.undefined().optional(),
  policy: CompanionMemoryPolicyCandidateDecisionSchema,
  vector: z.undefined().optional(),
}).strict();

export const CompanionMemoryCreateConfirmedResultSchema = z.object({
  storage: CompanionStorageStatusSchema,
  candidate: z.undefined().optional(),
  memory: CompanionConfirmedMemorySchema,
  policy: CompanionMemoryPolicyConfirmedDecisionSchema,
  vector: CompanionVectorStatusSchema,
}).strict();

export const CompanionMemoryCreateResultSchema = z.union([
  CompanionMemoryCreateBlockedResultSchema,
  CompanionMemoryCreateCandidateResultSchema,
  CompanionMemoryCreateConfirmedResultSchema,
]);
export type CompanionMemoryCreateResult = z.infer<
  typeof CompanionMemoryCreateResultSchema
>;

const companionMemoryEditableFields = {
  kind: CompanionMemoryKindSchema.optional(),
  key: z.string().trim().min(1).max(200).optional(),
  value: z.string().trim().min(2).max(500).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  importance: z.number().finite().min(0).max(1).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
};

export const CompanionMemoryEditOrConfirmRequestSchema = z.object({
  storageRoot: z.string().optional(),
  status: z.enum(["candidate", "confirmed"]).optional(),
  ...companionMemoryEditableFields,
}).strict().superRefine((value, ctx) => {
  const hasMutation = value.status !== undefined
    || Object.keys(companionMemoryEditableFields).some(
      (key) => value[key as keyof typeof companionMemoryEditableFields] !== undefined,
    );
  if (!hasMutation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "更新记忆至少提供一个变更字段",
      path: ["status"],
    });
  }
  if (
    value.status === "candidate"
    && (value.importance !== undefined || value.confidence !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "候选状态不能保存 importance 或 confidence",
      path: ["importance"],
    });
  }
});

export const CompanionMemoryRejectRequestSchema = z.object({
  storageRoot: z.string().optional(),
  status: z.literal("rejected"),
}).strict();

export const CompanionMemoryUpdateRequestSchema = z.union([
  CompanionMemoryRejectRequestSchema,
  CompanionMemoryEditOrConfirmRequestSchema,
]);
export type CompanionMemoryUpdateRequest = z.infer<
  typeof CompanionMemoryUpdateRequestSchema
>;

const memoryUpdateResultBase = {
  storage: CompanionStorageStatusSchema,
  vector: CompanionVectorStatusSchema,
  changed: z.boolean(),
};

export const CompanionMemoryCandidateBlockedResultSchema = z.object({
  outcome: z.literal("candidate_blocked"),
  ...memoryUpdateResultBase,
  changed: z.literal(false),
  candidate: CompanionPendingMemoryCandidateSchema,
  policy: CompanionMemoryPolicyBlockedDecisionSchema,
}).strict();

export const CompanionMemoryCandidateUpdatedResultSchema = z.object({
  outcome: z.literal("candidate_updated"),
  ...memoryUpdateResultBase,
  candidate: CompanionPendingMemoryCandidateSchema,
  policy: CompanionMemoryPolicyCandidateDecisionSchema,
}).strict();

export const CompanionMemoryCandidateRejectedResultSchema = z.object({
  outcome: z.literal("candidate_rejected"),
  ...memoryUpdateResultBase,
  candidate: CompanionRejectedMemoryCandidateSchema,
}).strict();

export const CompanionMemoryCandidateConfirmedResultSchema = z.object({
  outcome: z.literal("candidate_confirmed"),
  ...memoryUpdateResultBase,
  changed: z.literal(true),
  candidate: CompanionConfirmedMemoryCandidateSchema,
  memory: CompanionConfirmedMemorySchema,
  policy: CompanionMemoryPolicyConfirmedDecisionSchema,
}).strict();

export const CompanionMemoryCandidateAlreadyConfirmedResultSchema = z.object({
  outcome: z.literal("candidate_already_confirmed"),
  ...memoryUpdateResultBase,
  changed: z.literal(false),
  candidate: CompanionConfirmedMemoryCandidateSchema,
  memory: CompanionConfirmedMemorySchema,
}).strict();

export const CompanionMemoryBlockedResultSchema = z.object({
  outcome: z.literal("memory_blocked"),
  ...memoryUpdateResultBase,
  changed: z.literal(false),
  memory: CompanionConfirmedMemorySchema,
  policy: CompanionMemoryPolicyBlockedDecisionSchema,
}).strict();

export const CompanionMemoryReviewRequiredResultSchema = z.object({
  outcome: z.literal("memory_review_required"),
  ...memoryUpdateResultBase,
  changed: z.literal(false),
  memory: CompanionConfirmedMemorySchema,
  policy: CompanionMemoryPolicyCandidateDecisionSchema,
}).strict();

export const CompanionMemoryUpdatedResultSchema = z.object({
  outcome: z.literal("memory_updated"),
  ...memoryUpdateResultBase,
  memory: CompanionConfirmedMemorySchema,
  policy: CompanionMemoryPolicyConfirmedDecisionSchema,
}).strict();

export const CompanionMemoryUpdateResultSchema = z.discriminatedUnion("outcome", [
  CompanionMemoryCandidateBlockedResultSchema,
  CompanionMemoryCandidateUpdatedResultSchema,
  CompanionMemoryCandidateRejectedResultSchema,
  CompanionMemoryCandidateConfirmedResultSchema,
  CompanionMemoryCandidateAlreadyConfirmedResultSchema,
  CompanionMemoryBlockedResultSchema,
  CompanionMemoryReviewRequiredResultSchema,
  CompanionMemoryUpdatedResultSchema,
]);
export type CompanionMemoryUpdateResult = z.infer<
  typeof CompanionMemoryUpdateResultSchema
>;

const memoryDeletedIdentity = {
  outcome: z.literal("memory_deleted"),
  memoryId: z.string().min(1),
  candidateId: z.string().min(1).optional(),
};

const memoryCandidateDeletedIdentity = {
  outcome: z.literal("candidate_deleted"),
  candidateId: z.string().min(1),
  memoryId: z.string().min(1).optional(),
};

export const CompanionMemoryDeletionPersistenceSchema = z.discriminatedUnion("outcome", [
  z.object(memoryDeletedIdentity).strict(),
  z.object(memoryCandidateDeletedIdentity).strict(),
]);
export type CompanionMemoryDeletionPersistence = z.infer<
  typeof CompanionMemoryDeletionPersistenceSchema
>;

const memoryDeleteResultBase = {
  deleted: z.literal(true),
  requestedId: z.string().min(1),
  storage: CompanionStorageStatusSchema,
  vector: CompanionVectorStatusSchema,
};

export const CompanionMemoryDeletedResultSchema = z.object({
  ...memoryDeletedIdentity,
  ...memoryDeleteResultBase,
}).strict();

export const CompanionMemoryCandidateDeletedResultSchema = z.object({
  ...memoryCandidateDeletedIdentity,
  ...memoryDeleteResultBase,
}).strict();

export const CompanionMemoryDeleteResultSchema = z.discriminatedUnion("outcome", [
  CompanionMemoryDeletedResultSchema,
  CompanionMemoryCandidateDeletedResultSchema,
]);
export type CompanionMemoryDeleteResult = z.infer<
  typeof CompanionMemoryDeleteResultSchema
>;

export const CompanionMemorySearchRequestSchema = z.object({
  storageRoot: z.string().optional(),
  query: z.string().trim().min(1).max(500),
  outputMode: CompanionOutputModeInputSchema.optional(),
  topK: z.number().int().min(1).max(50).optional(),
}).strict();
export type CompanionMemorySearchRequest = z.infer<
  typeof CompanionMemorySearchRequestSchema
>;

export const CompanionMemorySearchMatchSchema = z.object({
  sourceType: z.enum(["memory", "summary"]),
  sourceId: z.string().min(1),
  outputMode: CompanionOutputModeSchema,
  content: z.string().min(1),
  summary: z.string().min(1).optional(),
  tags: z.array(z.string()),
  score: z.number().finite().min(-1).max(1),
}).strict();
export type CompanionMemorySearchMatch = z.infer<
  typeof CompanionMemorySearchMatchSchema
>;

const memorySearchPayload = {
  memories: z.array(CompanionConfirmedMemorySchema),
  summaries: z.array(CompanionSummarySchema),
  matches: z.array(CompanionMemorySearchMatchSchema),
};

export const CompanionBoundedMemorySearchResultSchema = z.object({
  outputMode: z.literal("bounded"),
  storages: z.object({
    primary: CompanionStorageStatusSchema,
  }).strict(),
  vectors: z.object({
    primary: CompanionVectorStatusSchema,
  }).strict(),
  ...memorySearchPayload,
}).strict();

export const CompanionUnrestrictedMemorySearchResultSchema = z.object({
  outputMode: z.literal("unrestricted"),
  storages: z.object({
    primary: CompanionStorageStatusSchema,
    unrestrictedMemory: CompanionStorageStatusSchema,
  }).strict(),
  vectors: z.object({
    primary: CompanionVectorStatusSchema,
    unrestrictedMemory: CompanionVectorStatusSchema,
  }).strict(),
  ...memorySearchPayload,
}).strict();

export const CompanionMemorySearchResultSchema = z.discriminatedUnion(
  "outputMode",
  [
    CompanionBoundedMemorySearchResultSchema,
    CompanionUnrestrictedMemorySearchResultSchema,
  ],
);
export type CompanionMemorySearchResult = z.infer<
  typeof CompanionMemorySearchResultSchema
>;
