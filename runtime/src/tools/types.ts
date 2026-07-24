import type { z } from "zod";

import type { ToolPermission } from "../core/permissions.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";
import type { SubAgentWorkflow } from "../subagent/SubAgentWorkflow.js";
import type { SuggestedToolAction, ToolOutcomeClass } from "./toolOutcome.js";

export type { ToolPermission };

export interface ToolContext {
  workspaceRoot: string;
  taskId?: string;
  sessionId?: string;
  requestId?: string;
  toolCallId?: string;
  storage?: import("./storage/ToolStorage.js").ToolStorage;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  signal?: AbortSignal;
  projectIndex?: import("../context/ProjectIndex.js").ProjectIndex;
  projectSemanticIndexer?: import("../context/ProjectSemanticIndexer.js").ProjectSemanticIndexer;
  historyFileRecaller?: import("../context/HistoryFileRecaller.js").HistoryFileRecaller;
  subAgentWorkflow?: SubAgentWorkflow;
  subAgentDispatchDepth?: number;
  maxSubAgentDispatchDepth?: number;
  sensitive?: boolean;
  parentAgentIntent?: string;
  parentAgentWorkflowType?: string;
  subAgentCostBudgetUsd?: number;
  projectAllowedPermissions?: ToolPermission[];
  workspaceAccess?: Record<string, unknown>;
  processSandbox?: import("../sandbox/ProcessSandbox.js").ProcessSandbox;
  hostCapabilities?: import("../host/HostCapabilityBroker.js").HostCapabilityBroker;
  resources?: import("../resources/ResourceRegistry.js").ResourceRegistry;
}

export const TOOL_RESOURCE_SCOPE_VALUES = [
  "workspace",
  "process",
  "git",
  "network",
  "browser",
  "external",
] as const;
export type ToolResourceScope = (typeof TOOL_RESOURCE_SCOPE_VALUES)[number];

export const TOOL_EFFECT_VALUES = [
  "none",
  "workspace_read",
  "workspace_write",
  "process",
  "network_write",
  "git_write",
  "unknown",
] as const;
export type ToolEffect = (typeof TOOL_EFFECT_VALUES)[number];

export const TOOL_RISK_VALUES = ["low", "medium", "high", "critical"] as const;
export type ToolRisk = (typeof TOOL_RISK_VALUES)[number];

export const TOOL_PARALLELISM_VALUES = ["parallel_safe", "serial"] as const;
export type ToolParallelism = (typeof TOOL_PARALLELISM_VALUES)[number];

export const TOOL_IDEMPOTENCY_VALUES = ["idempotent", "keyed", "non_idempotent"] as const;
export type ToolIdempotency = (typeof TOOL_IDEMPOTENCY_VALUES)[number];

export const TOOL_DATA_SENSITIVITY_VALUES = [
  "public",
  "workspace",
  "sensitive",
  "secret",
] as const;
export type ToolDataSensitivity = (typeof TOOL_DATA_SENSITIVITY_VALUES)[number];

export const TOOL_EGRESS_VALUES = ["none", "model", "network", "telemetry"] as const;
export type ToolEgress = (typeof TOOL_EGRESS_VALUES)[number];

/**
 * 工具的唯一运行时契约。Provider 描述必须从 inputSchema 派生，执行结果必须经过
 * outputSchema 校验；权限、副作用、恢复和外发属性不得在别处维护第二份规格。
 */
export interface ToolContract<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: TInput;
  outputSchema: z.ZodTypeAny;
  normalizeInput?: (rawInput: unknown) => unknown;
  /** 第一项是基础权限；动态工具可用 resolvePermissions 返回本次真实权限集。 */
  permissions: readonly [ToolPermission, ...ToolPermission[]];
  resolvePermissions?: (input: unknown) => ToolPermission[];
  resourceScopes: readonly ToolResourceScope[];
  effects: readonly ToolEffect[];
  risk: ToolRisk;
  parallelism: ToolParallelism;
  idempotency: ToolIdempotency;
  dataSensitivity: ToolDataSensitivity;
  egress: readonly ToolEgress[];
  timeoutMs: number;
  supportsResume: boolean;
  providerId: string;
  execute(input: z.infer<TInput>, context: ToolContext): Promise<TOutput>;
}

/** ToolContract 的只读投影；JSON Schema 由 Zod 直接生成。 */
export interface ToolContractSpec {
  name: string;
  version: string;
  description: string;
  permissions: [ToolPermission, ...ToolPermission[]];
  resourceScopes: ToolResourceScope[];
  effects: ToolEffect[];
  risk: ToolRisk;
  parallelism: ToolParallelism;
  idempotency: ToolIdempotency;
  dataSensitivity: ToolDataSensitivity;
  egress: ToolEgress[];
  timeoutMs: number;
  supportsResume: boolean;
  providerId: string;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "invalid_output"
  | "permission_denied"
  | "timeout"
  | "error";

export type ToolErrorCategory =
  | "user_error"
  | "environment_error"
  | "permission_error"
  | "temporary_error"
  | "unknown_error";

export interface ToolRunResult {
  tool: string;
  durationMs: number;
  toolCallId?: string;
  executed: boolean;
  outcomeClass: ToolOutcomeClass;
  outcomeKind: string;
  message: string;
  recoverable: boolean;
  requiresUserAction?: boolean;
  suggestedNextActions?: SuggestedToolAction[];
  outcomePath?: string;
  outcomeCommand?: string;
  outcomeExitCode?: number;
  output?: unknown;
  ok: boolean;
  code?: ToolErrorCode;
  category?: ToolErrorCategory;
  risk?: StructuredToolRisk;
  error?: string;
}
