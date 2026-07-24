import { z } from "zod";

/** 远程模型传输协议。Provider 身份由 providerId 单独表示。 */
export const ModelProviderSchema = z.enum(["openai-compatible", "anthropic-messages"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ReasoningModeSchema = z.enum(["off", "on", "auto", "pro"]);
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export const ModelInferenceProfileSchema = z.object({
  reasoning: z.object({
    modes: z.array(ReasoningModeSchema).min(1).max(4),
    defaultMode: ReasoningModeSchema,
    efforts: z.array(ReasoningEffortSchema).max(6),
    defaultEffort: ReasoningEffortSchema.optional(),
  }).superRefine((profile, context) => {
    if (new Set(profile.modes).size !== profile.modes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "可用推理模式不能重复。", path: ["modes"] });
    }
    if (new Set(profile.efforts).size !== profile.efforts.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "可用推理强度不能重复。", path: ["efforts"] });
    }
    if (!profile.modes.includes(profile.defaultMode)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "默认推理模式必须在可用模式中。", path: ["defaultMode"] });
    }
    if (profile.defaultEffort && !profile.efforts.includes(profile.defaultEffort)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "默认推理强度必须在可用强度中。", path: ["defaultEffort"] });
    }
    if (profile.efforts.length > 0 && !profile.defaultEffort) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "存在推理强度选项时必须设置默认值。", path: ["defaultEffort"] });
    }
  }).optional(),
});
export type ModelInferenceProfile = z.infer<typeof ModelInferenceProfileSchema>;

export const EmbeddedModelRuntimeSchema = z.enum(["llama.cpp", "transformers"]);
export type EmbeddedModelRuntime = z.infer<typeof EmbeddedModelRuntimeSchema>;

export const ModelLocationSchema = z.enum(["local", "remote"]);

export const RoutingStrategySchema = z.enum([
  "local-first",
  "cloud-first",
  "privacy-first",
  "quality-first",
]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

export const ModelDeclaredCapabilitiesSchema = z
  .object({
    text: z.boolean().optional(),
    image: z.boolean().optional(),
    audio: z.boolean().optional(),
    video: z.boolean().optional(),
    file: z.boolean().optional(),
    code: z.boolean().optional(),
    architecture: z.boolean().optional(),
    toolCalling: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    longContext: z.boolean().optional(),
    ocr: z.boolean().optional(),
    uiScreenshot: z.boolean().optional(),
    chartUnderstanding: z.boolean().optional(),
    diagramUnderstanding: z.boolean().optional(),
    spatialReasoning: z.boolean().optional(),
    imageGeneration: z.boolean().optional(),
    imageEditing: z.boolean().optional(),
  })
  .optional();

export const ModelPrivacyPolicySchema = z
  .object({
    local: z.boolean().optional(),
    remote: z.boolean().optional(),
    allowSensitive: z.boolean().optional(),
  })
  .optional();

export const ModelRouterProfileSchema = z.object({
  displayName: z.string().optional(),
  defaultLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsJsonMode: z.boolean().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  relativeCost: z.enum(["free", "low", "medium", "high"]).optional(),
  avgLatencyMs: z.number().int().positive().optional(),
  allowedTaskTypes: z.array(z.string()).optional(),
  allowedRoles: z.array(z.enum(["primary", "draft", "review", "final"])).optional(),
  canDraft: z.boolean().optional(),
  canReview: z.boolean().optional(),
  canFinal: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  /** Level 之外的细粒度能力声明（见 docs/模型路由Level与Capability分层设计.md）。 */
  capabilities: ModelDeclaredCapabilitiesSchema,
  privacy: ModelPrivacyPolicySchema,
});
export type ModelRouterProfileConfig = z.infer<typeof ModelRouterProfileSchema>;

const ModelClientConfigBaseSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  /** 可选计价：每 1k 输入 token 的美元价格（用于成本统计）。 */
  pricePer1kInputUsd: z.number().nonnegative().optional(),
  /** 可选计价：每 1k 输出 token 的美元价格。 */
  pricePer1kOutputUsd: z.number().nonnegative().optional(),
  /** 模型路由协作：等级、角色与能力（省略时按 location/模型名推断）。 */
  routerProfile: ModelRouterProfileSchema.optional(),
  /** 模型级可调推理能力；Provider adapter 负责映射为实际请求参数。 */
  inference: ModelInferenceProfileSchema.optional(),
});

export const ApiModelClientConfigSchema = ModelClientConfigBaseSchema.extend({
  kind: z.literal("api"),
  providerId: z.string().min(1),
  protocol: ModelProviderSchema,
  /** 外部 API 仅作为远程 transport；本地模型必须使用 embedded。 */
  location: z.literal("remote"),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().optional(),
  /** 仅 anthropic-messages：API 版本头，默认 2023-06-01。 */
  apiVersion: z.string().optional(),
  /** 仅 anthropic-messages：messages API 必填 max_tokens 的默认值。 */
  maxTokens: z.number().int().positive().optional(),
});

export const EmbeddedModelClientConfigSchema = ModelClientConfigBaseSchema.extend({
  kind: z.literal("embedded"),
  runtime: EmbeddedModelRuntimeSchema,
  location: z.literal("local"),
  /** GGUF 文件或 Transformers 模型目录的规范化绝对路径。 */
  modelPath: z.string().min(1),
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.union([z.literal("auto"), z.number().int().nonnegative()]).optional(),
  device: z.enum(["auto", "cpu", "cuda", "vulkan"]).optional(),
  maxTokens: z.number().int().positive().optional(),
  firstTokenTimeoutMs: z.number().int().positive().optional(),
  tokenIdleTimeoutMs: z.number().int().positive().optional(),
});

export const ModelClientConfigSchema = z.discriminatedUnion("kind", [
  ApiModelClientConfigSchema,
  EmbeddedModelClientConfigSchema,
]);
export type ModelClientConfig = z.infer<typeof ModelClientConfigSchema>;
export type ApiModelClientConfig = z.infer<typeof ApiModelClientConfigSchema>;
export type EmbeddedModelClientConfig = z.infer<typeof EmbeddedModelClientConfigSchema>;

export const SchedulerConfigSchema = z.object({
  /** goal 子串匹配时通知 payload 不要求确认（无人值守白名单）。 */
  unattendedGoalPatterns: z.array(z.string()).default([]),
  gitPollIntervalMs: z.number().int().positive().default(5000),
  cronMissPolicy: z.enum(["skip", "run_once"]).default("skip"),
  /** 启动时注册 daily_summary cron（可选，如 `0 9 * * *`）。 */
  dailySummaryCron: z.string().optional(),
  dailySummaryGoal: z.string().optional(),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

const ToolPermissionSchema = z.enum(["read", "write", "shell", "network", "dangerous"]);

export const SandboxConfigSchema = z
  .object({
    /** workspace-write/read-only 使用 Windows 原生 helper；完全访问明确使用宿主身份。 */
    mode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .default("workspace-write"),
    /** 相对 Ariadne 项目根，或绝对路径。 */
    helperPath: z.string().min(1).optional(),
    /** DPAPI 凭据与 setup manifest 目录；必须位于工作区外。 */
    stateRoot: z.string().min(1).optional(),
    /** 除当前工作区外允许写入的根目录。 */
    writableRoots: z.array(z.string().min(1)).max(64).default([]),
    /** AppContainer 可读取并执行的用户安装工具根；系统目录由 Windows 自身提供。 */
    toolReadRoots: z.array(z.string().min(1)).max(64).default([]),
    /** 工作区内仍保持只读的绝对路径或相对 Ariadne 项目根路径。 */
    readOnlySubpaths: z
      .array(z.string().min(1))
      .max(64)
      .default(["../.git", "../.agent", "../.agents"]),
    /** 离线身份是否允许访问 127.0.0.0/8 与 ::1。 */
    allowLoopback: z.boolean().default(false),
    offlineUser: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(20)
      .default("AriadneOffline"),
    onlineUser: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(20)
      .default("AriadneOnline"),
    writerGroup: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(20)
      .default("AriadneWriters"),
    resourceLimits: z
      .object({
        maxProcesses: z.number().int().min(1).max(128).default(32),
        maxMemoryBytes: z
          .number()
          .int()
          .min(64 * 1024 * 1024)
          .max(16 * 1024 ** 3)
          .optional(),
        maxCpuTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
      })
      .default({ maxProcesses: 32 }),
  })
  .default({
    mode: "workspace-write",
    writableRoots: [],
    toolReadRoots: [],
    readOnlySubpaths: ["../.git", "../.agent", "../.agents"],
    allowLoopback: false,
    offlineUser: "AriadneOffline",
    onlineUser: "AriadneOnline",
    writerGroup: "AriadneWriters",
    resourceLimits: { maxProcesses: 32 },
  });
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const SecurityConfigSchema = z.object({
  permissions: z
    .object({
      /** 项目级权限上限；未配置则允许全部内置权限。 */
      allowed: z.array(ToolPermissionSchema).optional(),
    })
    .optional(),
  shell: z
    .object({
      /** 正则列表：命中任一条时拒绝 shell_run / 后台命令。 */
      denyCommands: z.array(z.string().min(1)).default([]),
      /** 正则列表：配置后 shell_run / 后台命令必须命中任一条。 */
      allowCommands: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  network: z
    .object({
      /** 正则列表：命中任一条时拒绝网络工具访问（对规范化 hostname 匹配）。 */
      denyDomains: z.array(z.string().min(1)).default([]),
      /** 正则列表：配置后网络工具目标必须命中任一条；未配置则不启用 allowlist。 */
      allowDomains: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  sandbox: SandboxConfigSchema,
  budget: z
    .object({
      /** 单次 Agent Run 允许的最大估算费用（USD）；超出则中断循环。 */
      maxCostUsdPerRun: z.number().positive().optional(),
    })
    .optional(),
  subagent: z
    .object({
      /**
       * dispatch_subagent 允许的最大派生深度（主 Agent 为 0）。
       * 默认 1 = 仅主 Agent 可派生；不支持无限递归。
       */
      maxDispatchDepth: z.number().int().min(0).max(3).default(1),
      /** 批量 dispatch_subagent 最大并行子任务数（缓解本地模型并发排队）。 */
      maxBatchConcurrency: z.number().int().min(1).max(3).default(2),
      /** 子 Agent 默认超时（ms）；单任务 timeoutMs 不得低于 MIN 120s。 */
      defaultTimeoutMs: z.number().int().min(120_000).max(600_000).optional(),
      /** 本地模型子 Agent 同时运行上限（背压队列）。 */
      localModelMaxConcurrent: z.number().int().min(1).max(3).default(1),
    })
    .default({ maxDispatchDepth: 1, maxBatchConcurrency: 2, localModelMaxConcurrent: 1 }),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const WorkspaceConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** 相对 Ariadne 项目根目录，或绝对路径。 */
  root: z.string().min(1),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const AppConfigSchema = z.object({
  workspaceRoot: z.string().min(1),
  /** 可选多工作区；省略时仅使用 workspaceRoot 作为唯一「default」工作区。 */
  workspaces: z.array(WorkspaceConfigSchema).optional(),
  models: z.object({
    default: z.string().min(1).default("auto"),
    /** 相对 Ariadne 项目根目录，或任意绝对路径；默认项目同级 Models/。 */
    directory: z.string().min(1).default("../Models"),
    autoDiscover: z.boolean().default(true),
    watch: z.boolean().default(true),
    loadPolicy: z.literal("lazy").default("lazy"),
    maxLoadedModels: z.number().int().min(1).max(4).default(1),
    idleUnloadMs: z.number().int().min(10_000).default(10 * 60_000),
    clients: z.array(ModelClientConfigSchema).default([]),
  }),
  routing: z.object({
    strategy: RoutingStrategySchema,
    fallback: z.boolean(),
  }),
  scheduler: SchedulerConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
