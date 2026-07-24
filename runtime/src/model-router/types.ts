import type { ModelDeclaredCapabilities, ModelPrivacyPolicy } from "./model-capability-profile.js";

export const TASK_TYPE_VALUES = [
  "casual_chat",
  "companion_chat",
  "memory_write",
  "memory_search",
  "summary",
  "intent_classification",
  "simple_qa",
  "technical_qa",
  "code_question",
  "code_edit",
  "architecture",
  "debug",
  "document_qa",
  "image_qa",
  "tool_action",
  "high_risk_action",
  "unknown",
] as const;
export type TaskType = (typeof TASK_TYPE_VALUES)[number];

export const MODEL_LEVEL_VALUES = [0, 1, 2, 3] as const;
export type ModelLevel = (typeof MODEL_LEVEL_VALUES)[number];

export const EXECUTION_STRATEGY_VALUES = [
  "rule_only",
  "single_model",
  "strong_model_direct",
  "local_draft_remote_review",
  "parallel_vote",
] as const;
export type ExecutionStrategy = (typeof EXECUTION_STRATEGY_VALUES)[number];

/** V2 FallbackManager 触发原因（见 Agent_Model_Router_Auto_Upgrade_Roadmap §5.2）。 */
export type FallbackTrigger =
  | "model_timeout"
  | "model_error"
  | "empty_output"
  | "json_parse_failed"
  | "review_rejected"
  | "review_failed"
  | "answer_too_short";

export interface FallbackPlan {
  fromModelId: string;
  toModelId: string;
  fromStrategy: ExecutionStrategy;
  toStrategy: ExecutionStrategy;
  trigger: FallbackTrigger;
  reason: string;
  maxAttempts: number;
}

export type ModelRole = "primary" | "draft" | "review" | "final";

export type QualityMode = "fast" | "balanced" | "deep";

export type RiskLevel = "low" | "medium" | "high";

export interface ModelProfile {
  id: string;
  displayName: string;
  provider: "local" | "api" | "mock";
  defaultLevel: ModelLevel;
  enabled: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  relativeCost: "free" | "low" | "medium" | "high";
  avgLatencyMs?: number;
  allowedTaskTypes: TaskType[];
  allowedRoles: ModelRole[];
  canDraft: boolean;
  canReview: boolean;
  canFinal: boolean;
  tags?: string[];
  /** 细粒度能力（会不会）；与 defaultLevel（强不强）分层。 */
  declaredCapabilities: ModelDeclaredCapabilities;
  privacy: ModelPrivacyPolicy;
}

export interface RouterInput {
  sessionId?: string;
  projectId?: string;
  userInput: string;
  mode?: "chat" | "project" | "memory" | "tool";
  qualityMode?: QualityMode;
  hasAttachments?: boolean;
  attachmentTypes?: Array<"image" | "pdf" | "doc" | "code" | "audio" | "unknown">;
  mayUseTools?: boolean;
  mayModifyWorkspace?: boolean;
  contextTokenEstimate?: number;
  recentMessagesCount?: number;
  /** 已累计估算费用（USD），供 CostBudgetManager 选型。 */
  spentCostUsd?: number;
  /** 本请求/会话成本上限（USD），供 CostBudgetManager 选型。 */
  maxCostUsd?: number;
  allowCollaboration?: boolean;
  forceSingleModel?: boolean;
  /** 敏感任务：仅允许本地模型。 */
  localOnly?: boolean;
  /** 显式覆盖任务类型（跳过关键词分类）。 */
  taskTypeOverride?: TaskType;
  /** 手动指定模型 id（client name）。 */
  forceModelId?: string;
  /** 调用方不可降级的能力要求；Agent 可执行协议通过这里传入。 */
  requiredCapabilities?: Array<keyof ModelDeclaredCapabilities>;
  /** AgentAction 严格协议路径：除声明能力外，还应用运行资格/隔离状态。 */
  agentProtocolRequired?: boolean;
}

export interface RuleRouteResult {
  taskType: TaskType;
  requiredLevel: ModelLevel;
  risk: RiskLevel;
  reason: string;
  requireVision?: boolean;
  requireTools?: boolean;
  requireJsonMode?: boolean;
  requireUserConfirmation?: boolean;
  preferCollaboration?: boolean;
  preferredStrategy?: ExecutionStrategy;
  /** 任务必须具备的能力键（见 model-capability-profile.ts）。 */
  requiredCapabilities?: Array<keyof ModelDeclaredCapabilities>;
  preferredCapabilities?: Array<keyof ModelDeclaredCapabilities>;
}

export interface RouterDecision {
  id: string;
  sessionId?: string;
  projectId?: string;
  taskType: TaskType;
  selectedLevel: ModelLevel;
  risk: RiskLevel;
  reason: string;
  source: "rule" | "manual_override" | "fallback" | "evaluator" | "runtime_stats" | "cost_budget";
  executionStrategy: ExecutionStrategy;
  selectedModelId?: string;
  draftModelId?: string;
  reviewModelId?: string;
  finalModelId?: string;
  /** parallel_vote：并行作答的模型 id（2 个）。 */
  voteModelIds?: string[];
  /** parallel_vote：裁决模型 id。 */
  judgeModelId?: string;
  requireUserConfirmation: boolean;
  candidates: string[];
  createdAt: string;
  /** 策略降级说明（如无 review 模型时）。 */
  fallbackNote?: string;
  /** V8：ContextAnalyzer 信号摘要（可解释路由）。 */
  contextSignals?: string[];
}

export interface DraftReviewIssue {
  severity: "low" | "medium" | "high";
  message: string;
}

export interface DraftReviewResult {
  verdict: "approve" | "revise" | "reject";
  confidence: number;
  issues: DraftReviewIssue[];
  revisedAnswer?: string;
}

export class RouterError extends Error {
  constructor(
    readonly code:
      | "NO_AVAILABLE_MODEL"
      | "NO_REVIEW_MODEL_AVAILABLE"
      | "RULE_ONLY_NOT_IMPLEMENTED"
      | "MODEL_CAPABILITY_MISMATCH"
      | "MODEL_PROTOCOL_QUARANTINED",
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}
