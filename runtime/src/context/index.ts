export { ProjectIndex, projectFileToScanMeta, extractSymbolsFromContent } from "./ProjectIndex.js";
export { ProjectSemanticIndexer } from "./ProjectSemanticIndexer.js";
export { HistoryFileRecaller } from "./HistoryFileRecaller.js";
export {
  CodeIntelligenceService,
  TypeScriptAstIntelligenceProvider,
  TextFallbackIntelligenceProvider,
} from "./CodeIntelligenceService.js";
export {
  LspCodeIntelligenceProvider,
  type LspAnalysisTransport,
  type LspServerConfiguration,
} from "./LspCodeIntelligenceProvider.js";
export { TreeSitterWasmIntelligenceProvider } from "./TreeSitterWasmIntelligenceProvider.js";
export type { HistoryFileHit, HistoryFileSource } from "./HistoryFileRecaller.js";
export { extractFilePathsFromText, isLikelyWorkspaceFile } from "./filePathExtract.js";
export {
  extractImportsFromContent,
  extractExportsFromContent,
  resolveImportSpec,
} from "./importExportParser.js";
export type * from "./projectIndexTypes.js";
export { ContextManager, createLlmSummarize } from "./ContextManager.js";
export { DatabaseManager, estimateTokens } from "./DatabaseManager.js";
export {
  EmbeddingService,
  LocalLexicalEmbeddingProvider,
  LocalGgufEmbeddingProvider,
  MockEmbeddingProvider,
  ApiEmbeddingProvider,
  EMBEDDING_DIMENSION,
} from "./EmbeddingService.js";
export { ContextRestorer } from "./ContextRestorer.js";
export {
  buildContextCorrections,
  claimsCompletionInText,
  evaluateContextMessageTrust,
  filterVerifiedMemories,
  shouldIncludeInContext,
} from "./contextTrust.js";
export { RunFactsLookup, parseRunResultJson } from "./runFactsLookup.js";
export { backfillMessageEnvelopes } from "./messageEnvelopeBackfill.js";
export { MemoryRetriever } from "./MemoryRetriever.js";
export { MemoryManager } from "./MemoryManager.js";
export {
  RuleMemoryExtractor,
  createLlmMemoryExtractor,
  type IMemoryExtractor,
} from "./MemoryExtractor.js";
export { SemanticRetriever } from "./SemanticRetriever.js";
export { SystemSectionBuilder } from "./SystemSectionBuilder.js";
export { PromptBuilder } from "./PromptBuilder.js";
export {
  createContentEnvelope,
  defaultUiVisible,
  inferEnvelopeFromLegacy,
  isContextVerifiedMessage,
  isVerifiedContent,
  isVerifiedUiChatBubble,
  resolveMessageEnvelope,
} from "./messageEnvelope.js";
export type {
  ContentEnvelope,
  ContentOrigin,
  InstructionAuthority,
  MessageEnvelope,
  MessageEnvelopeInput,
  MessageKind,
} from "./messageEnvelope.js";
export { SummaryManager } from "./SummaryManager.js";
export {
  SessionStore,
  MessageStore,
  SummaryStore,
  MemoryStore,
  ProjectStore,
  TaskStore,
} from "./stores.js";
export {
  InMemoryVectorStore,
  LanceDbVectorStore,
  createVectorStore,
} from "./VectorStore.js";
export type { VectorStore, VectorStoreStatus } from "./VectorStore.js";
export type * from "./types.js";
