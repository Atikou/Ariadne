import type { CompanionOutputMode } from "./CompanionMemoryContracts.js";

export type {
  CompanionMessage,
  CompanionMessageRole,
  CompanionMessageStatus,
  CompanionSession,
  CompanionSessionDeleteResult,
  CompanionSessionDeletionPersistence,
  CompanionSessionDeletionStats,
  CompanionMemoryContextDeletionStats,
  CompanionStorageStatus,
  CompanionSummary,
  CompanionSummaryStatus,
} from "./CompanionSessionContracts.js";
export type {
  CompanionPersona,
  CompanionPersonaVersion,
} from "./CompanionPersonaContracts.js";
export type { CompanionVectorStatus } from "./CompanionVectorContracts.js";
export type {
  CompanionChatInput,
  CompanionChatResult,
  CompanionChatResource,
  CompanionSafetyResult,
} from "./CompanionChatContracts.js";
export type {
  CompanionConfirmedMemory,
  CompanionConfirmedMemoryCandidate,
  CompanionMemory,
  CompanionMemoryCandidate,
  CompanionMemoryCollection,
  CompanionMemoryCreateResult,
  CompanionMemoryDeleteResult,
  CompanionMemoryKind,
  CompanionMemoryListResult,
  CompanionMemoryPolicyDecision,
  CompanionMemorySearchMatch,
  CompanionMemorySearchRequest,
  CompanionMemorySearchResult,
  CompanionMemorySensitivity,
  CompanionMemoryStatus,
  CompanionMemoryStatusDecision,
  CompanionMemoryUpdateRequest,
  CompanionMemoryUpdateResult,
  CompanionOutputMode,
  CompanionOutputModeInput,
  CompanionPendingMemoryCandidate,
  CompanionRejectedMemoryCandidate,
} from "./CompanionMemoryContracts.js";

export interface CompanionVectorItem {
  id: string;
  sourceType: "memory" | "summary";
  sourceId: string;
  outputMode: CompanionOutputMode;
  content: string;
  summary?: string;
  indexedAt: string;
}
