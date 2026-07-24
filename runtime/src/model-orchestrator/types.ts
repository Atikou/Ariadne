import type { DraftReviewResult, ExecutionStrategy, RouterDecision } from "../model-router/types.js";
import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { ModelRole } from "../model-router/types.js";

export interface RenderedPrompt {
  systemSectionsText: string;
  finalMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface OrchestratorInput {
  routerDecision: RouterDecision;
  renderedPrompt: RenderedPrompt;
  userInput: string;
  sessionId?: string;
  temperature?: number;
  /** 隐私/敏感任务：fallback 也只能选择本地模型。 */
  localOnly?: boolean;
  /** 流式 token 回调（仅 single_model / strong_model_direct 管线消费）。 */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface OrchestratorResult {
  finalAnswer: string;
  usedStrategy: ExecutionStrategy;
  usedModelIds: string[];
  collaborationRunId?: string;
  modelCallIds: string[];
  reviewResult?: DraftReviewResult;
  voteResult?: import("./pipelines/parallel-vote-pipeline.js").ParallelVoteResult;
  fallbackCount?: number;
  fallbackLogIds?: string[];
  clientName?: string;
  modelName?: string;
  location?: string;
  latencyMs?: number;
  usage?: ModelResponse["usage"];
}

export interface PipelineFallbackContext {
  manager: import("../model-router/fallback-manager.js").FallbackManager;
  logStore: import("../model-router/route-stores.js").FallbackLogStore;
  recordFallback: (logId: string) => void;
  localOnly?: boolean;
}

export interface ModelChatResult {
  response: ModelResponse;
  callLogId: string;
}

export type ModelChatFn = (
  modelId: string,
  request: ChatRequest,
  meta: {
    role: ModelRole;
    routeLogId: string;
    collaborationRunId?: string;
    sessionId?: string;
  },
) => Promise<ModelChatResult>;

export type { DraftReviewResult };
