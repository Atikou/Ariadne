import type { ModelClientConfig } from "../config/types.js";
import {
  buildModelDeclaredCapabilitiesFromClient,
  buildModelPrivacyFromClient,
} from "./model-capability-profile.js";
import type { ModelProfile, ModelRole, TaskType } from "./types.js";

const ALL_TASK_TYPES: TaskType[] = [
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
];

const LEVEL1_TASKS: TaskType[] = [
  "casual_chat",
  "companion_chat",
  "memory_write",
  "memory_search",
  "summary",
  "intent_classification",
  "simple_qa",
  "unknown",
];

const LEVEL2_TASKS: TaskType[] = [
  "technical_qa",
  "code_question",
  "debug",
  "document_qa",
  "summary",
  "simple_qa",
  "architecture",
];

const LEVEL3_TASKS: TaskType[] = [
  "architecture",
  "code_edit",
  "debug",
  "document_qa",
  "image_qa",
  "tool_action",
  "high_risk_action",
  "technical_qa",
  "code_question",
];

function isStrongRemote(name: string, model: string): boolean {
  const hay = `${name} ${model}`.toLowerCase();
  return /claude|sonnet|opus|gpt-4|gpt-4o|o1|o3|deepseek-reasoner|strong/.test(hay);
}

function defaultAllowedTasks(level: 1 | 2 | 3): TaskType[] {
  if (level === 1) return LEVEL1_TASKS;
  if (level === 2) return [...new Set([...LEVEL1_TASKS, ...LEVEL2_TASKS])];
  return [...ALL_TASK_TYPES];
}

function normalizeProfileLevel(level: ModelProfile["defaultLevel"]): 1 | 2 | 3 {
  if (level <= 1) return 1;
  if (level === 2) return 2;
  return 3;
}

function defaultMaxInputTokens(level: 1 | 2 | 3): number {
  return level === 1 ? 8192 : level === 2 ? 32000 : 128000;
}

function defaultMaxOutputTokens(level: 1 | 2 | 3): number {
  return level === 1 ? 2048 : level === 2 ? 4096 : 8192;
}

function inferDefaults(client: ModelClientConfig): Omit<
  ModelProfile,
  "id" | "displayName" | "provider" | "declaredCapabilities" | "privacy"
> {
  const isLocal = client.location === "local";
  const strong = !isLocal && isStrongRemote(client.name, client.model);
  const level = isLocal ? 1 : strong ? 3 : 2;
  const cost = isLocal ? "free" : strong ? "high" : "medium";
  const roles: ModelRole[] = isLocal
    ? ["primary", "draft"]
    : strong
      ? ["primary", "review", "final"]
      : ["primary", "review", "final", "draft"];

  return {
    defaultLevel: level,
    enabled: true,
    supportsStreaming: isLocal,
    supportsTools: false,
    supportsVision: strong && client.protocol === "anthropic-messages",
    supportsJsonMode: false,
    maxInputTokens: defaultMaxInputTokens(level),
    maxOutputTokens: defaultMaxOutputTokens(level),
    relativeCost: cost,
    avgLatencyMs: isLocal ? 800 : strong ? 2500 : 1500,
    allowedTaskTypes: defaultAllowedTasks(level),
    allowedRoles: roles,
    canDraft: isLocal || level >= 2,
    canReview: !isLocal && level >= 2,
    canFinal: true,
    tags: isLocal ? ["local", "cheap", "draft"] : strong ? ["api", "strong"] : ["api", "general"],
  };
}

/** 从 AppConfig 客户端列表构建 ModelProfile（能力来自配置 + 可选手动 routerProfile）。 */
export function buildModelProfiles(clients: ModelClientConfig[]): ModelProfile[] {
  return clients.map((client) => {
    const inferred = inferDefaults(client);
    const rp = client.routerProfile;
    const level = (rp?.defaultLevel ?? inferred.defaultLevel) as ModelProfile["defaultLevel"];
    const profileLevel = normalizeProfileLevel(level);
    const levelWasOverridden = rp?.defaultLevel !== undefined && rp.defaultLevel !== inferred.defaultLevel;
    const supportsVision = rp?.supportsVision ?? inferred.supportsVision;
    const supportsTools = rp?.supportsTools
      ?? rp?.capabilities?.toolCalling
      ?? (client.kind === "api"
        && (client.qualification.nativeTools === "supported"
          || client.qualification.textFallback === "supported"));
    const supportsJsonMode = rp?.supportsJsonMode
      ?? rp?.capabilities?.jsonMode
      ?? inferred.supportsJsonMode;
    const maxInputTokens =
      rp?.maxInputTokens ??
      (levelWasOverridden ? defaultMaxInputTokens(profileLevel) : inferred.maxInputTokens);
    const maxOutputTokens =
      rp?.maxOutputTokens ??
      (levelWasOverridden ? defaultMaxOutputTokens(profileLevel) : inferred.maxOutputTokens);
    return {
      id: client.name,
      displayName: rp?.displayName ?? client.name,
      provider: client.location === "local" ? "local" : "api",
      defaultLevel: level,
      enabled: rp?.enabled ?? inferred.enabled,
      supportsStreaming: rp?.supportsStreaming
        ?? (client.kind === "api"
          ? client.qualification.streaming === "supported"
          : inferred.supportsStreaming),
      supportsTools,
      supportsVision,
      supportsJsonMode,
      maxInputTokens,
      maxOutputTokens,
      relativeCost: rp?.relativeCost ?? inferred.relativeCost,
      avgLatencyMs: rp?.avgLatencyMs ?? inferred.avgLatencyMs,
      allowedTaskTypes:
        (rp?.allowedTaskTypes as TaskType[] | undefined) ??
        (levelWasOverridden ? defaultAllowedTasks(profileLevel) : inferred.allowedTaskTypes),
      allowedRoles: (rp?.allowedRoles as ModelRole[] | undefined) ?? inferred.allowedRoles,
      canDraft: rp?.canDraft ?? inferred.canDraft,
      canReview: rp?.canReview ?? inferred.canReview,
      canFinal: rp?.canFinal ?? inferred.canFinal,
      tags: rp?.tags ?? inferred.tags,
      declaredCapabilities: buildModelDeclaredCapabilitiesFromClient(client, {
        defaultLevel: level,
        supportsVision,
        supportsTools,
        supportsJsonMode,
        maxInputTokens,
      }),
      privacy: buildModelPrivacyFromClient(client),
    };
  });
}

export function validateModelProfiles(profiles: ModelProfile[]): string[] {
  const errors: string[] = [];
  const enabled = profiles.filter((p) => p.enabled);
  if (!enabled.some((p) => p.canFinal)) {
    errors.push("至少需要一个 enabled 且 canFinal=true 的模型");
  }
  const draft = enabled.filter((p) => p.canDraft);
  const review = enabled.filter((p) => p.canReview);
  if (draft.length === 0) {
    errors.push("协作需要至少一个 canDraft 模型（可仅本地）");
  }
  if (review.length === 0) {
    errors.push("协作需要至少一个 canReview 模型（可仅远程）");
  }
  return errors;
}
