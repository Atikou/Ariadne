import type { ChatMessage, ToolCall } from "../model/types.js";
import type { ContextTrustDecisionReason } from "./contextTrust.js";

/** 摘要类型：chunk / session / daily / task。 */
export type SummaryType = "chunk_summary" | "session_summary" | "daily_summary" | "task_summary";

/** 结构化摘要内容。 */
export interface StructuredSummary {
  current_goal?: string;
  important_decisions?: string[];
  user_preferences?: string[];
  project_state?: string[];
  open_questions?: string[];
  recent_changes?: string[];
  important_files?: string[];
  tool_results?: string[];
  errors_seen?: string[];
}

export type MemoryScope = "global" | "session" | "project" | "task";
export type MemoryLifecycleState =
  | "candidate"
  | "active"
  | "rejected"
  | "superseded"
  | "expired";
export type MemorySensitivity = "public" | "workspace" | "sensitive" | "secret";
export interface MemoryProvenance {
  origin: "user" | "model_summary" | "tool_ledger" | "workspace" | "system";
  sourceId?: string;
  evidence?: string;
}

export type MemoryType =
  | "preference"
  | "habit"
  | "decision"
  | "fact"
  | "lesson"
  | "project_note"
  | "recent_state"
  | "task_state"
  | "known_issue"
  | "tech_stack";

export type MemoryRetrieveReason =
  | "fixed_preference"
  | "project_context"
  | "task_context"
  | "fts"
  | "semantic"
  | "recent";

export interface SessionRecord {
  id: string;
  title: string;
  status: "active" | "archived";
  projectId?: string;
  /** 绑定的工作区 catalog id（见 config.workspaces）。 */
  workspaceKey?: string;
  lastMessageId?: string;
  activeTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  tokenEstimate: number;
  isSummarized: boolean;
  summaryId?: string;
  clientName?: string;
  modelName?: string;
  messageKind?: import("./messageEnvelope.js").MessageKind;
  uiVisible?: boolean;
  contentEnvelope?: import("./messageEnvelope.js").ContentEnvelope;
  runId?: string;
  ledgerBacked?: boolean;
  outcomeClass?: string;
  outcomeKind?: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface SummaryRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  summaryType: SummaryType;
  content: StructuredSummary;
  contentText: string;
  structuredJson?: string;
  startMessageId?: string;
  endMessageId?: string;
  tokenCount: number;
  schemaVersion: 1;
  generationState: "model" | "derived" | "degraded";
  degradedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId?: string;
  memoryType: MemoryType;
  key?: string;
  value: string;
  summary?: string;
  importance: number;
  confidence: number;
  lifecycleState: MemoryLifecycleState;
  provenance: MemoryProvenance;
  sensitivity: MemorySensitivity;
  retentionUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  supersedesId?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  sessionId?: string;
  projectId?: string;
  goal: string;
  status: string;
  summary?: string;
  inputs?: string[];
  outputs?: string[];
  acceptanceCriteria?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskStepRecord {
  id: string;
  taskId: string;
  stepId: string;
  position: number;
  title: string;
  objective?: string;
  description?: string;
  status: string;
  requiredPermissions: string[];
  needsConfirmation: boolean;
  acceptance?: string;
  dependsOn: string[];
  requiredContext: string[];
  availableTools: string[];
  expectedArtifacts: string[];
  priority: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttemptRecord {
  id: string;
  taskId: string;
  stepId?: string;
  runId?: string;
  status: string;
  error?: string;
  result?: string;
  startedAt: string;
  endedAt?: string;
}

export interface SemanticItem {
  id: string;
  itemType: "chat" | "summary" | "memory" | "document" | "image" | "screenshot" | "code";
  scope: MemoryScope;
  scopeId?: string;
  sourceType: string;
  sourceId: string;
  content: string;
  summary?: string;
  vector: number[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SemanticHit {
  item: SemanticItem;
  score: number;
  reason: "semantic";
}

export interface RetrievedMemory {
  memory: MemoryRecord;
  score: number;
  reason: MemoryRetrieveReason;
  /** 记忆可信度：verified=工具/账本事实，inferred=摘要推断，unverified=未验证完成声明等。 */
  trustLevel?: MemoryTrustLevel;
  sourceKind?: string;
}

export type MemoryTrustLevel = "verified" | "inferred" | "unverified";

export type SystemSectionType =
  | "user_preferences"
  | "session_summary"
  | "context_corrections"
  | "task_state"
  | "current_plan"
  | "file_snippets"
  | "project_context"
  | "relevant_memories"
  | "semantic_results"
  | "recent_tool_results"
  | "response_rules";

export interface SystemSectionItem {
  sourceType: "memory" | "summary" | "project" | "task" | "semantic" | "tool" | "file";
  sourceId?: string;
  text: string;
  score?: number;
  contentEnvelope: import("./messageEnvelope.js").ContentEnvelope;
  /** 片段标签，用于检索过滤与按标签重组上下文。 */
  tags?: string[];
}

export interface TaggedFragment {
  id: string;
  tags: string[];
  sourceType: SystemSectionItem["sourceType"];
  sourceId?: string;
  sectionType: SystemSectionType;
  text: string;
}

export interface SystemSection {
  type: SystemSectionType;
  title: string;
  priority: number;
  items: SystemSectionItem[];
}

/** 上下文包中的消息（含持久化 id，便于摘要/压缩/去重排查）。 */
export interface ContextMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  messageKind?: import("./messageEnvelope.js").MessageKind;
  uiVisible?: boolean;
  contentEnvelope?: import("./messageEnvelope.js").ContentEnvelope;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ContextTrustExcludedMessage {
  messageId: string;
  role: string;
  reason: ContextTrustDecisionReason;
  preview: string;
}

/** ContextRestorer 去污审计：被排除消息与纠偏摘要（debug / API 预览）。 */
export interface ContextTrustReport {
  includedCount: number;
  excludedCount: number;
  excluded: ContextTrustExcludedMessage[];
  corrections: string[];
}

/** ContextRestorer 返回的结构化上下文包（唯一结构化上下文主对象）。 */
export interface ContextPackage {
  sessionId: string;
  projectId?: string;
  taskId?: string;
  systemSections: SystemSection[];
  /** 扁平化带标签片段，便于按标签检索与重组。 */
  taggedFragments: TaggedFragment[];
  messages: ContextMessage[];
  summaries: SummaryRecord[];
  memories: RetrievedMemory[];
  semanticHits: SemanticHit[];
  projectContext?: ProjectRecord;
  activeTask?: TaskRecord;
  /** 上下文去污报告（恢复阶段 debug，不写入模型 user 气泡）。 */
  contextTrust?: ContextTrustReport;
}

export type ContextPhase = "pre_call" | "post_call";

/** 调试快照：PromptBuilder 渲染结果，不持久化、不写回 contextPackage。 */
export interface RenderedPrompt {
  systemSectionsText: string;
  finalMessages: ChatMessage[];
}

/** 带阶段的调试快照（仅用于模型调用预览与 API 调试，非主数据）。 */
export interface ContextDebugSnapshot {
  phase: ContextPhase;
  contextPackage: ContextPackage;
  renderedPrompt: RenderedPrompt;
}

export interface RestoreContextInput {
  sessionId: string;
  userInput?: string;
  projectId?: string;
  taskId?: string;
}

export interface MemoryRetrieveInput {
  userInput: string;
  sessionId: string;
  projectId?: string;
  taskId?: string;
  scopes?: MemoryScope[];
  limit?: number;
  /** 至少命中其一的标签过滤。 */
  tags?: string[];
}

export interface SemanticSearchInput {
  query: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  tags?: string[];
}

export interface SummaryGenerationResult {
  schemaVersion: 1;
  content: StructuredSummary;
  generationState: "model" | "degraded";
  degradedReason?: string;
}

export type SummarizeFn = (messages: MessageRecord[]) => Promise<SummaryGenerationResult>;

export interface SearchHit {
  source: "fts" | "vector";
  itemType: string;
  sourceId: string;
  content: string;
  score: number;
  tags?: string[];
}

export interface MemoryCandidate {
  scope: MemoryScope;
  scopeId?: string;
  memoryType: MemoryType;
  key?: string;
  value: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  provenance: MemoryProvenance;
  sensitivity?: MemorySensitivity;
  retentionUntil?: string;
}
