import type { ModelTaskType } from "../model/taskType.js";
import type { QualityMode, RouterInput, TaskType } from "./types.js";

function legacyTaskTypeToRouter(legacy?: ModelTaskType): TaskType | undefined {
  switch (legacy) {
    case "simple":
      return "simple_qa";
    case "reasoning":
      return "architecture";
    case "codegen":
      return "code_edit";
    case "long_context":
      return "document_qa";
    default:
      return undefined;
  }
}

export function buildRouterInputFromChat(payload: {
  message: string;
  sessionId?: string;
  sensitive?: boolean;
  qualityMode?: QualityMode;
  taskType?: ModelTaskType;
  allowCollaboration?: boolean;
  forceSingleModel?: boolean;
  hasAttachments?: boolean;
  attachmentTypes?: RouterInput["attachmentTypes"];
  forceModelId?: string;
  mayUseTools?: boolean;
  requiredCapabilities?: RouterInput["requiredCapabilities"];
  agentProtocolRequired?: boolean;
  contextTokenEstimate?: number;
  recentMessagesCount?: number;
  maxCostUsd?: number;
  spentCostUsd?: number;
}): RouterInput {
  let qualityFromLegacy: QualityMode = payload.qualityMode ?? "balanced";
  if (!payload.qualityMode && payload.taskType) {
    qualityFromLegacy = payload.taskType === "simple" ? "fast" : "deep";
  }

  return {
    sessionId: payload.sessionId,
    userInput: payload.message,
    mode: "chat",
    qualityMode: qualityFromLegacy,
    localOnly: payload.sensitive,
    allowCollaboration: payload.allowCollaboration ?? qualityFromLegacy !== "fast",
    forceSingleModel: payload.forceSingleModel,
    hasAttachments: payload.hasAttachments,
    attachmentTypes: payload.attachmentTypes,
    forceModelId: payload.forceModelId,
    taskTypeOverride: legacyTaskTypeToRouter(payload.taskType),
    contextTokenEstimate: payload.contextTokenEstimate,
    recentMessagesCount: payload.recentMessagesCount,
    mayUseTools: payload.mayUseTools,
    requiredCapabilities: payload.requiredCapabilities,
    agentProtocolRequired: payload.agentProtocolRequired,
    maxCostUsd: payload.maxCostUsd,
    spentCostUsd: payload.spentCostUsd,
  };
}
