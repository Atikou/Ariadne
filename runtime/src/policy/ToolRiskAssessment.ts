import { z } from "zod";

import type { ToolPermission } from "../core/permissions.js";
import { CONFIRMATION_REQUIRED } from "../core/permissions.js";
import type { NetworkPolicy } from "./NetworkPolicy.js";
import { extractNetworkTarget } from "./NetworkPolicy.js";
import type { ShellPolicy } from "./ShellPolicy.js";
import { checkCommandRisk, type RiskLevel } from "../tools/risk.js";

export const ToolRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);
export type ToolRiskTier = z.infer<typeof ToolRiskTierSchema>;

export const ToolRiskCategorySchema = z.enum([
  "file_write",
  "file_patch",
  "shell_command",
  "network_access",
  "dangerous_op",
  "permission_boundary",
]);
export type ToolRiskCategory = z.infer<typeof ToolRiskCategorySchema>;

/** 高风险工具统一风险结构，供 HTTP 确认门、Agent 步骤与审计页展示。 */
export const StructuredToolRiskSchema = z.object({
  tier: ToolRiskTierSchema,
  category: ToolRiskCategorySchema,
  summary: z.string().min(1),
  reasons: z.array(z.string().min(1)),
  requiresConfirmation: z.boolean(),
  policyBlocked: z.boolean(),
  /** shell_run 沿用既有 safe/caution/dangerous 分级，便于与后台任务对齐。 */
  commandLevel: z.enum(["safe", "caution", "dangerous"]).optional(),
  target: z.string().min(1).optional(),
  matchedRule: z.string().min(1).optional(),
}).strict();
export type StructuredToolRisk = z.infer<typeof StructuredToolRiskSchema>;

export interface AssessToolRiskOptions {
  toolName: string;
  permission: ToolPermission;
  input: unknown;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  preview?: {
    kind?: string;
    path?: string;
    isNew?: boolean;
    command?: string;
  };
}

const SENSITIVE_PATH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.env(\.|$)/i, reason: "环境变量/密钥文件" },
  { re: /package-lock\.json$/i, reason: "依赖锁定文件" },
  { re: /(^|\/)config\/.*\.json$/i, reason: "运行配置" },
  { re: /(^|\/)\.git\//i, reason: "Git 元数据" },
  { re: /AGENTS\.md$/i, reason: "Agent 入口文档" },
];

export function riskLevelToTier(level: RiskLevel): ToolRiskTier {
  if (level === "dangerous") return "critical";
  if (level === "caution") return "medium";
  return "low";
}

export function assessToolRisk(options: AssessToolRiskOptions): StructuredToolRisk {
  const { toolName, permission, input, shellPolicy, networkPolicy, preview } = options;

  if (
    toolName === "shell_run" ||
    toolName === "background_shell_start" ||
    preview?.kind === "shell_run"
  ) {
    const command =
      preview?.command ??
      (typeof (input as { command?: string }).command === "string"
        ? (input as { command: string }).command
        : "");
    return assessShellCommandRisk(command, shellPolicy);
  }

  if (toolName === "write_file" || preview?.kind === "write_file") {
    const path =
      preview?.path ??
      (typeof (input as { path?: string }).path === "string" ? (input as { path: string }).path : "");
    const isNew = preview?.isNew ?? false;
    return assessFileWriteRisk(path, isNew);
  }

  if (toolName === "apply_patch" || preview?.kind === "apply_patch") {
    const path =
      preview?.path ??
      (typeof (input as { path?: string }).path === "string" ? (input as { path: string }).path : "");
    return assessFilePatchRisk(path);
  }

  if (permission === "network") {
    const target = extractNetworkTarget(input);
    return assessNetworkAccessRisk(target, networkPolicy);
  }

  if (permission === "dangerous") {
    return {
      tier: "critical",
      category: "dangerous_op",
      summary: "危险权限操作",
      reasons: ["工具声明 dangerous 权限，可能产生不可逆副作用"],
      requiresConfirmation: true,
      policyBlocked: false,
    };
  }

  if (CONFIRMATION_REQUIRED.includes(permission)) {
    return {
      tier: permission === "write" ? "medium" : "medium",
      category: permission === "write" ? "file_write" : "permission_boundary",
      summary: `需要确认的 ${permission} 权限操作`,
      reasons: [`工具「${toolName}」需要用户确认后执行`],
      requiresConfirmation: true,
      policyBlocked: false,
    };
  }

  return {
    tier: "low",
    category: "permission_boundary",
    summary: "低风险只读操作",
    reasons: [],
    requiresConfirmation: false,
    policyBlocked: false,
  };
}

export function assessShellCommandRisk(command: string, shellPolicy?: ShellPolicy): StructuredToolRisk {
  const trimmed = command.trim();
  const verdict = checkCommandRisk(trimmed);
  const decision = shellPolicy?.evaluate(trimmed);
  const policyBlocked = decision?.blocked === true;
  const commandLevel = verdict.level;
  const reasons = [verdict.reason];
  if (decision?.reason) reasons.push(decision.reason);

  let tier = riskLevelToTier(verdict.level);
  if (policyBlocked) tier = "critical";

  return {
    tier,
    category: "shell_command",
    summary: policyBlocked
      ? "命令被安全策略拒绝"
      : verdict.level === "dangerous"
        ? "高危 Shell 命令"
        : verdict.level === "caution"
          ? "需谨慎的 Shell 命令"
          : "Shell 命令执行",
    reasons,
    requiresConfirmation: CONFIRMATION_REQUIRED.includes("shell"),
    policyBlocked,
    commandLevel,
    target: trimmed || undefined,
    matchedRule: decision?.matchedRule,
  };
}

export function assessFileWriteRisk(path: string, isNew: boolean): StructuredToolRisk {
  const sensitive = matchSensitivePath(path);
  const tier: ToolRiskTier = sensitive ? "high" : isNew ? "medium" : "medium";
  const reasons = [
    isNew ? "将创建新文件" : "将覆盖或修改已有文件",
    ...(sensitive ? [sensitive.reason] : []),
  ];
  return {
    tier,
    category: "file_write",
    summary: isNew ? "写入新文件" : "修改工作区文件",
    reasons,
    requiresConfirmation: true,
    policyBlocked: false,
    target: path || undefined,
  };
}

export function assessFilePatchRisk(path: string): StructuredToolRisk {
  const sensitive = matchSensitivePath(path);
  return {
    tier: sensitive ? "high" : "medium",
    category: "file_patch",
    summary: "应用文本补丁",
    reasons: ["将就地替换文件片段", ...(sensitive ? [sensitive.reason] : [])],
    requiresConfirmation: true,
    policyBlocked: false,
    target: path || undefined,
  };
}

export function assessNetworkAccessRisk(
  target: string | undefined,
  networkPolicy?: NetworkPolicy,
): StructuredToolRisk {
  if (target && networkPolicy) {
    const decision = networkPolicy.evaluateTarget(target);
    if (decision.blocked) {
      return {
        tier: "critical",
        category: "network_access",
        summary: "网络目标被域名策略拒绝",
        reasons: [decision.reason ?? `域名 ${decision.hostname} 不允许访问`],
        requiresConfirmation: true,
        policyBlocked: true,
        target,
        matchedRule: decision.matchedRule,
      };
    }
  }

  return {
    tier: "medium",
    category: "network_access",
    summary: target ? `访问网络目标：${target}` : "联网访问",
    reasons: target ? ["将对外发起网络请求"] : ["工具需要 network 权限"],
    requiresConfirmation: true,
    policyBlocked: false,
    target,
  };
}

export function assessPermissionDeniedRisk(
  permission: ToolPermission,
  reason: string,
  options?: { toolName?: string; input?: unknown; shellPolicy?: ShellPolicy; networkPolicy?: NetworkPolicy },
): StructuredToolRisk {
  const base = assessToolRisk({
    toolName: options?.toolName ?? "unknown",
    permission,
    input: options?.input ?? {},
    shellPolicy: options?.shellPolicy,
    networkPolicy: options?.networkPolicy,
  });
  return {
    ...base,
    tier: "critical",
    policyBlocked: true,
    summary: "权限或策略拒绝",
    reasons: [reason, ...base.reasons],
  };
}

function matchSensitivePath(path: string): { reason: string } | undefined {
  const normalized = path.replace(/\\/g, "/");
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.re.test(normalized)) return { reason: `敏感路径：${pattern.reason}` };
  }
  return undefined;
}
