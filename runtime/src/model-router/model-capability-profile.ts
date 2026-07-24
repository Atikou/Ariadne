import type { ModelClientConfig } from "../config/types.js";
import type { ModelProfile, ModelLevel, RuleRouteResult } from "./types.js";

/** 配置声明的能力画像（Level = 强弱；capabilities = 会不会）。 */
export interface ModelDeclaredCapabilities {
  text: boolean;
  image: boolean;
  audio: boolean;
  video: boolean;
  file: boolean;
  code: boolean;
  architecture: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  longContext: boolean;
  ocr: boolean;
  uiScreenshot: boolean;
  chartUnderstanding: boolean;
  diagramUnderstanding: boolean;
  spatialReasoning: boolean;
  imageGeneration: boolean;
  imageEditing: boolean;
}

export interface ModelPrivacyPolicy {
  local: boolean;
  remote: boolean;
  /** 是否允许接收 sensitive=true 任务（仍须 location 匹配）。 */
  allowSensitive: boolean;
}

export type DeclaredCapabilityKey = keyof ModelDeclaredCapabilities;

/** AgentAction 是可执行协议，进入 AgentLoop 的模型必须同时具备这两项能力。 */
export const AGENT_PROTOCOL_REQUIRED_CAPABILITIES = ["toolCalling", "jsonMode"] as const satisfies readonly DeclaredCapabilityKey[];

export interface TaskRequirement {
  minLevel: ModelLevel;
  requiredCapabilities: DeclaredCapabilityKey[];
  preferredCapabilities: DeclaredCapabilityKey[];
  sensitive: boolean;
  localOnly: boolean;
}

const CAPABILITY_KEYS: DeclaredCapabilityKey[] = [
  "text",
  "image",
  "audio",
  "video",
  "file",
  "code",
  "architecture",
  "toolCalling",
  "jsonMode",
  "longContext",
  "ocr",
  "uiScreenshot",
  "chartUnderstanding",
  "diagramUnderstanding",
  "spatialReasoning",
  "imageGeneration",
  "imageEditing",
];

export function emptyDeclaredCapabilities(): ModelDeclaredCapabilities {
  return {
    text: false,
    image: false,
    audio: false,
    video: false,
    file: false,
    code: false,
    architecture: false,
    toolCalling: false,
    jsonMode: false,
    longContext: false,
    ocr: false,
    uiScreenshot: false,
    chartUnderstanding: false,
    diagramUnderstanding: false,
    spatialReasoning: false,
    imageGeneration: false,
    imageEditing: false,
  };
}

/** 从配置 capabilities 片段合并（未声明字段保持 undefined 供推断）。 */
export function parseDeclaredCapabilitiesFromConfig(
  raw?: Partial<Record<DeclaredCapabilityKey, boolean>>,
): Partial<ModelDeclaredCapabilities> | undefined {
  if (!raw) return undefined;
  const out: Partial<ModelDeclaredCapabilities> = {};
  for (const key of CAPABILITY_KEYS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function levelBand(level: ModelLevel): "light" | "general" | "strong" {
  if (level <= 1) return "light";
  if (level === 2) return "general";
  return "strong";
}

/** 未在 routerProfile.capabilities 声明时，由 level / location / 旧 supports* 字段推断。 */
export function inferDeclaredCapabilities(input: {
  isLocal: boolean;
  defaultLevel: ModelLevel;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  maxInputTokens: number;
  overrides?: Partial<ModelDeclaredCapabilities>;
}): ModelDeclaredCapabilities {
  const band = levelBand(input.defaultLevel);
  const base = emptyDeclaredCapabilities();

  base.text = true;
  base.file = input.isLocal || band !== "light";

  if (band === "light") {
    base.code = false;
    base.architecture = false;
    base.toolCalling = false;
    base.jsonMode = false;
    base.longContext = false;
  } else if (band === "general") {
    base.code = true;
    base.architecture = false;
    base.toolCalling = input.supportsTools;
    base.jsonMode = input.supportsJsonMode;
    base.longContext = input.maxInputTokens >= 32000;
  } else {
    base.code = true;
    base.architecture = true;
    base.toolCalling = input.supportsTools || !input.isLocal;
    base.jsonMode = input.supportsJsonMode || !input.isLocal;
    base.longContext = input.maxInputTokens >= 32000;
  }

  if (input.supportsVision) {
    base.image = true;
    base.ocr = band !== "light";
    base.uiScreenshot = band === "strong";
    base.chartUnderstanding = band !== "light";
    base.diagramUnderstanding = band === "strong";
    base.spatialReasoning = band === "strong";
  }

  if (input.overrides) {
    for (const key of CAPABILITY_KEYS) {
      if (typeof input.overrides[key] === "boolean") base[key] = input.overrides[key]!;
    }
  }

  return base;
}

export function inferPrivacyPolicy(input: {
  isLocal: boolean;
  overrides?: Partial<ModelPrivacyPolicy>;
}): ModelPrivacyPolicy {
  const base: ModelPrivacyPolicy = {
    local: input.isLocal,
    remote: !input.isLocal,
    allowSensitive: input.isLocal,
  };
  if (input.overrides) {
    if (typeof input.overrides.local === "boolean") base.local = input.overrides.local;
    if (typeof input.overrides.remote === "boolean") base.remote = input.overrides.remote;
    if (typeof input.overrides.allowSensitive === "boolean") {
      base.allowSensitive = input.overrides.allowSensitive;
    }
  }
  return base;
}

export function mergeDeclaredCapabilities(
  profile: Pick<
    ModelProfile,
    "declaredCapabilities" | "defaultLevel" | "supportsVision" | "supportsTools" | "supportsJsonMode" | "maxInputTokens" | "provider"
  >,
): ModelDeclaredCapabilities {
  return profile.declaredCapabilities;
}

function ensureDeclaredCapabilities(profile: ModelProfile): ModelDeclaredCapabilities {
  if (profile.declaredCapabilities) return profile.declaredCapabilities;
  return inferDeclaredCapabilities({
    isLocal: profile.provider === "local",
    defaultLevel: profile.defaultLevel,
    supportsVision: profile.supportsVision,
    supportsTools: profile.supportsTools,
    supportsJsonMode: profile.supportsJsonMode,
    maxInputTokens: profile.maxInputTokens,
  });
}

function ensurePrivacyPolicy(profile: ModelProfile): ModelPrivacyPolicy {
  if (profile.privacy) return profile.privacy;
  return inferPrivacyPolicy({ isLocal: profile.provider === "local" });
}

export function profileHasDeclaredCapability(
  profile: ModelProfile,
  capability: DeclaredCapabilityKey,
): boolean {
  return ensureDeclaredCapabilities(profile)[capability] === true;
}

export function profileSatisfiesDeclaredCapabilities(
  profile: ModelProfile,
  required: readonly DeclaredCapabilityKey[],
): boolean {
  const caps = ensureDeclaredCapabilities(profile);
  return required.every((cap) => caps[cap] === true);
}

export function profileSupportsAgentProtocol(profile: ModelProfile): boolean {
  return profileSatisfiesDeclaredCapabilities(profile, AGENT_PROTOCOL_REQUIRED_CAPABILITIES);
}

export function profileSatisfiesPrivacy(
  profile: ModelProfile,
  input: { sensitive: boolean; localOnly: boolean },
): boolean {
  const privacy = ensurePrivacyPolicy(profile);
  if (input.localOnly || input.sensitive) {
    if (profile.provider === "local") return true;
    return privacy.allowSensitive;
  }
  return true;
}

const TASK_DEFAULT_REQUIRED: Partial<Record<RuleRouteResult["taskType"], DeclaredCapabilityKey[]>> = {
  casual_chat: ["text"],
  companion_chat: ["text"],
  simple_qa: ["text"],
  technical_qa: ["text", "code"],
  code_question: ["text", "code"],
  code_edit: ["text", "code", "toolCalling"],
  architecture: ["text", "code", "architecture"],
  debug: ["text", "code"],
  document_qa: ["text"],
  image_qa: ["text", "image"],
  tool_action: ["text", "toolCalling"],
  high_risk_action: ["text", "code", "toolCalling", "jsonMode"],
  unknown: ["text"],
};

const TASK_DEFAULT_PREFERRED: Partial<Record<RuleRouteResult["taskType"], DeclaredCapabilityKey[]>> = {
  architecture: ["jsonMode", "longContext"],
  image_qa: ["ocr"],
  document_qa: ["longContext"],
};

const UI_SCREENSHOT_RE =
  /ui|界面|截图|按钮|布局|面板|弹窗|样式|显示不对|screenshot/i;
const DIAGRAM_RE = /架构图|流程图|关系图|时序图|diagram|mermaid/i;
const CHART_RE = /图表|趋势|坐标轴|chart|柱状|折线/i;
const OCR_RE = /ocr|识别.*文字|读.*图.*字|报错截图|终端截图/i;
const IMAGE_GEN_RE = /生成.*图|画图|作图|image generation|generate.*image/i;
const IMAGE_EDIT_RE = /编辑.*图|改.*图|image edit/i;

export function resolveTaskRequirement(
  rule: RuleRouteResult,
  input: { userInput: string; localOnly?: boolean; hasAttachments?: boolean; attachmentTypes?: string[] },
): TaskRequirement {
  const required = [...(rule.requiredCapabilities ?? TASK_DEFAULT_REQUIRED[rule.taskType] ?? ["text"])];
  const preferred = [...(rule.preferredCapabilities ?? TASK_DEFAULT_PREFERRED[rule.taskType] ?? [])];

  const text = input.userInput.trim();
  const hasImageAttachment =
    input.hasAttachments === true || (input.attachmentTypes?.includes("image") ?? false);

  if (hasImageAttachment && !required.includes("image")) {
    required.push("image");
  }
  if (hasImageAttachment && UI_SCREENSHOT_RE.test(text) && !required.includes("uiScreenshot")) {
    required.push("uiScreenshot");
    if (!preferred.includes("ocr")) preferred.push("ocr");
    if (!preferred.includes("spatialReasoning")) preferred.push("spatialReasoning");
  } else if (hasImageAttachment && DIAGRAM_RE.test(text) && !required.includes("diagramUnderstanding")) {
    required.push("diagramUnderstanding");
    if (!required.includes("architecture") && /架构/.test(text)) {
      required.push("architecture");
    }
  } else if (hasImageAttachment && CHART_RE.test(text) && !required.includes("chartUnderstanding")) {
    required.push("chartUnderstanding");
  } else if (hasImageAttachment && OCR_RE.test(text) && !required.includes("ocr")) {
    required.push("ocr");
    if (!preferred.includes("code")) preferred.push("code");
  }

  if (IMAGE_GEN_RE.test(text) && !required.includes("imageGeneration")) {
    required.push("imageGeneration");
  }
  if (IMAGE_EDIT_RE.test(text) && !required.includes("imageEditing")) {
    required.push("imageEditing");
  }

  if (rule.requireVision && !required.includes("image")) {
    required.push("image");
  }

  return {
    minLevel: rule.requiredLevel,
    requiredCapabilities: [...new Set(required)],
    preferredCapabilities: [...new Set(preferred)],
    sensitive: input.localOnly === true,
    localOnly: input.localOnly === true,
  };
}

export function explainNoAvailableModel(
  rule: RuleRouteResult,
  input: { userInput: string; localOnly?: boolean; hasAttachments?: boolean; attachmentTypes?: string[] },
  candidates: ModelProfile[],
  enabled: ModelProfile[],
): string {
  const req = resolveTaskRequirement(rule, input);
  const lines: string[] = [];

  const missingCaps = req.requiredCapabilities.filter(
    (cap) => !enabled.some((p) => profileHasDeclaredCapability(p, cap)),
  );
  if (missingCaps.length > 0) {
    lines.push(`缺少所需能力：${missingCaps.join("、")}。`);
  }

  const levelOk = enabled.filter((p) => p.defaultLevel >= req.minLevel);
  if (levelOk.length === 0 && enabled.length > 0) {
    lines.push(`需要 Level ≥ ${req.minLevel}，当前可用模型最高为 Level ${Math.max(...enabled.map((p) => p.defaultLevel))}。`);
  }

  if (input.localOnly) {
    const remoteWithCaps = candidates.filter(
      (p) =>
        p.provider !== "local" &&
        profileSatisfiesDeclaredCapabilities(p, req.requiredCapabilities) &&
        p.defaultLevel >= req.minLevel,
    );
    if (remoteWithCaps.length > 0) {
      lines.push(
        "敏感/本地优先策略（localOnly）已排除远程模型；可显式选择远程模型或关闭 sensitive。",
      );
    }
  }

  if (lines.length === 0) {
    return `没有可用模型满足当前任务要求（taskType=${rule.taskType}，minLevel=${req.minLevel}）。`;
  }

  lines.push("可选：显式选择模型、配置对应 API Key/Models 目录模型，或调整 routerProfile.capabilities。");
  return lines.join("\n");
}

export function buildModelPrivacyFromClient(client: ModelClientConfig): ModelPrivacyPolicy {
  const isLocal = client.location === "local";
  return inferPrivacyPolicy({
    isLocal,
    overrides: client.routerProfile?.privacy as Partial<ModelPrivacyPolicy> | undefined,
  });
}

export function buildModelDeclaredCapabilitiesFromClient(
  client: ModelClientConfig,
  flags: {
    defaultLevel: ModelLevel;
    supportsVision: boolean;
    supportsTools: boolean;
    supportsJsonMode: boolean;
    maxInputTokens: number;
  },
): ModelDeclaredCapabilities {
  return inferDeclaredCapabilities({
    isLocal: client.location === "local",
    defaultLevel: flags.defaultLevel,
    supportsVision: flags.supportsVision,
    supportsTools: flags.supportsTools,
    supportsJsonMode: flags.supportsJsonMode,
    maxInputTokens: flags.maxInputTokens,
    overrides: parseDeclaredCapabilitiesFromConfig(
      client.routerProfile?.capabilities as Partial<Record<DeclaredCapabilityKey, boolean>> | undefined,
    ),
  });
}
