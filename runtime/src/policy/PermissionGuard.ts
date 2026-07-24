import type { AgentIntentType } from "../agent/IntentTypes.js";
import type { ToolPermission } from "../core/permissions.js";
import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import { assessPermissionDeniedRisk, assessToolRisk, type StructuredToolRisk } from "./ToolRiskAssessment.js";
import type { ScopedApprovedPermissions } from "./permissionRequestTypes.js";
import { isToolCallGranted } from "./scopedPermissionCheck.js";
import type { ShellPolicy } from "./ShellPolicy.js";
import type { NetworkPolicy } from "./NetworkPolicy.js";

export type PermissionGuardDecisionKind = "allow" | "needsConfirmation" | "deny";

export interface PermissionGuardDecision {
  decision: PermissionGuardDecisionKind;
  reason?: string;
  risk: StructuredToolRisk;
  confirmationRequest?: PermissionConfirmationRequest;
}

export interface PermissionConfirmationRequest {
  status: "waiting_confirmation" | "denied";
  title: string;
  message: string;
  tool: string;
  permission: ToolPermission;
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  action: string;
  affects: {
    files: string[];
    commands: string[];
    networkTargets: string[];
  };
  risk: {
    tier: StructuredToolRisk["tier"];
    category: StructuredToolRisk["category"];
    summary: string;
    reasons: string[];
  };
}

export interface PermissionGuardInput {
  intent: AgentIntentType;
  permissionPolicy: UserPermissionPolicy;
  toolName: string;
  permission: ToolPermission;
  input: unknown;
  allowedPermissions: ToolPermission[];
  /** Server-issued permissions for this Run. Policies and request booleans cannot populate this field. */
  runGrantedPermissions?: readonly ToolPermission[];
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  scopedGrants?: ScopedApprovedPermissions;
  /** 当前被暂停工具调用经用户确认后签发的一次性精确授权。 */
  confirmedScopedGrants?: ScopedApprovedPermissions;
}

export function evaluatePermissionGuard(input: PermissionGuardInput): PermissionGuardDecision {
  if (!input.allowedPermissions.includes(input.permission)) {
    const reason = `当前模式不允许的权限：${input.permission}`;
    const risk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "denied", "权限策略已拒绝"),
    };
  }

  if (input.permissionPolicy === "readOnly" && input.permission !== "read") {
    const reason = `权限策略 readOnly 不允许 ${input.permission} 操作`;
    const risk = assessPermissionDeniedRisk(input.permission, reason, {
      toolName: input.toolName,
      input: input.input,
      shellPolicy: input.shellPolicy,
      networkPolicy: input.networkPolicy,
    });
    return {
      decision: "deny",
      reason,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "denied", "权限策略已拒绝"),
    };
  }

  const risk = assessToolRisk({
    toolName: input.toolName,
    permission: input.permission,
    input: input.input,
    shellPolicy: input.shellPolicy,
    networkPolicy: input.networkPolicy,
  });

  if (input.permission === "read") {
    return { decision: "allow", risk };
  }

  // autoRun represents an explicit full-access choice from a trusted host. It
  // still cannot create authority by itself: only a server-issued Run grant
  // for the exact permission may bypass the risk confirmation gate.
  if (
    input.permissionPolicy === "autoRun" &&
    input.runGrantedPermissions?.includes(input.permission)
  ) {
    return { decision: "allow", risk };
  }

  const forcedConfirmation = resolveForcedConfirmation(input, risk);
  if (forcedConfirmation) {
    if (
      input.confirmedScopedGrants &&
      isToolCallGranted({
        toolName: input.toolName,
        permission: input.permission,
        toolInput: input.input,
        grants: input.confirmedScopedGrants,
      })
    ) {
      return { decision: "allow", risk };
    }
    const forcedRisk = withForcedConfirmationReason(risk, forcedConfirmation.reason);
    return {
      decision: "needsConfirmation",
      reason: forcedConfirmation.reason,
      risk: forcedRisk,
      confirmationRequest: buildConfirmationRequest(
        input,
        forcedRisk,
        "waiting_confirmation",
        "等待确认高风险操作",
      ),
    };
  }

  if (
    input.scopedGrants &&
    isToolCallGranted({
      toolName: input.toolName,
      permission: input.permission,
      toolInput: input.input,
      grants: input.scopedGrants,
    })
  ) {
    return { decision: "allow", risk };
  }

  if (input.runGrantedPermissions?.includes(input.permission)) {
    return { decision: "allow", risk };
  }

  if (input.permission === "write") {
    return {
      decision: "needsConfirmation",
      reason: `权限策略 ${input.permissionPolicy} 要求确认写入操作`,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认写入操作"),
    };
  }

  if (input.permission === "shell" || input.permission === "network") {
    return {
      decision: "needsConfirmation",
      reason: `工具「${input.toolName}」需要 ${input.permission} 授权`,
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认执行操作"),
    };
  }

  if (input.permission === "dangerous") {
    return {
      decision: "needsConfirmation",
      reason: "dangerous 权限操作必须取得精确授权",
      risk,
      confirmationRequest: buildConfirmationRequest(input, risk, "waiting_confirmation", "等待确认高风险操作"),
    };
  }

  return { decision: "allow", risk };
}

function buildConfirmationRequest(
  input: PermissionGuardInput,
  risk: StructuredToolRisk,
  status: PermissionConfirmationRequest["status"],
  title: string,
): PermissionConfirmationRequest {
  const affects = extractAffectedTargets(input, risk);
  const action = describeAction(input);
  const targetText = [
    affects.files.length ? `文件：${affects.files.join(", ")}` : "",
    affects.commands.length ? `命令：${affects.commands.join(" && ")}` : "",
    affects.networkTargets.length ? `网络：${affects.networkTargets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return {
    status,
    title,
    message: `${action}${targetText ? `（${targetText}）` : ""}。风险：${risk.summary}`,
    tool: input.toolName,
    permission: input.permission,
    intent: input.intent,
    permissionPolicy: input.permissionPolicy,
    action,
    affects,
    risk: {
      tier: risk.tier,
      category: risk.category,
      summary: risk.summary,
      reasons: [...risk.reasons],
    },
  };
}

function describeAction(input: PermissionGuardInput): string {
  if (input.permission === "write") {
    if (input.toolName === "apply_patch") return "应用文件补丁";
    if (input.toolName === "write_file") return "写入工作区文件";
    return "执行写入类操作";
  }
  if (input.permission === "shell") return "执行 Shell 命令";
  if (input.permission === "network") return "访问网络资源";
  if (input.permission === "dangerous") return "执行高风险操作";
  return "执行工具调用";
}

function extractAffectedTargets(
  input: PermissionGuardInput,
  risk: StructuredToolRisk,
): PermissionConfirmationRequest["affects"] {
  const record = isRecord(input.input) ? input.input : {};
  const files = [
    readString(record.path),
    readString(record.file),
    ...readStringArray(record.files),
    ...readStringArray(record.paths),
  ].filter((value): value is string => Boolean(value));
  const command = readString(record.command);
  const url = readString(record.url) || readString(record.endpoint);
  const target = risk.target;
  return {
    files: unique(files),
    commands: command ? [command] : [],
    networkTargets: unique([url, target].filter((value): value is string => Boolean(value))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 20);
}

function resolveForcedConfirmation(
  input: PermissionGuardInput,
  risk: StructuredToolRisk,
): { reason: string } | undefined {
  if (input.permission === "dangerous") {
    return { reason: "dangerous 权限操作必须人工确认" };
  }

  if (input.permission === "write") {
    const targets = extractAffectedTargets(input, risk).files;
    if (risk.tier === "high" || risk.tier === "critical") {
      return { reason: "高风险文件写入必须人工确认" };
    }
    if (targets.some(isSensitivePath)) {
      return { reason: "涉及密钥、配置或 Git 元数据的写入必须人工确认" };
    }
    if (targets.length >= 20) {
      return { reason: "批量修改大量文件必须人工确认" };
    }
  }

  if (input.permission === "shell") {
    const command = readCommand(input.input);
    if (!command) return undefined;
    for (const rule of FORCED_SHELL_CONFIRMATION_RULES) {
      if (rule.re.test(command)) return { reason: rule.reason };
    }
    if (risk.commandLevel === "dangerous" || risk.tier === "critical") {
      return { reason: "高危 Shell 命令必须人工确认" };
    }
  }

  if (input.permission === "network" && risk.tier === "critical") {
    return { reason: "被网络策略标记为高风险的访问必须人工确认" };
  }

  return undefined;
}

const FORCED_SHELL_CONFIRMATION_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+commit\b/i, reason: "提交操作必须人工确认" },
  { re: /\bgit\s+push\b/i, reason: "提交推送操作必须人工确认" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "硬重置工作区必须人工确认" },
  { re: /\bgit\s+clean\s+(-[a-z]*f|--force)/i, reason: "清理未跟踪文件必须人工确认" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: "递归强制删除必须人工确认" },
  { re: /\brmdir\s+\/s\b/i, reason: "递归删除目录必须人工确认" },
  { re: /\brd\s+\/s\b/i, reason: "递归删除目录必须人工确认" },
  { re: /\bdel\s+\/[sf]\b/i, reason: "批量删除文件必须人工确认" },
  { re: /\bRemove-Item\b[^\n]*\s-(Recurse|r)\b[^\n]*\s-(Force|f)\b/i, reason: "递归强制删除必须人工确认" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|powershell|pwsh|cmd)\b/i, reason: "联网下载后直接执行脚本必须人工确认" },
  { re: /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*iex\b/i, reason: "PowerShell 远程脚本执行必须人工确认" },
  { re: /\b(npm|pnpm|yarn)\s+(install|add|i)\b[^\n]*\s(-g|--global)\b/i, reason: "全局安装依赖必须人工确认" },
  { re: /\byarn\s+global\s+add\b/i, reason: "全局安装依赖必须人工确认" },
  { re: /\bnpm\s+publish\b/i, reason: "发布包必须人工确认" },
  { re: /\b(setx|export)\b[^\n]*(TOKEN|SECRET|KEY|PASSWORD)/i, reason: "修改密钥相关环境变量必须人工确认" },
  { re: /\b(cat|type|Get-Content)\b[^\n]*(\.env|id_rsa|credentials|secrets?)/i, reason: "读取或暴露密钥文件必须人工确认" },
];

function withForcedConfirmationReason(
  risk: StructuredToolRisk,
  reason: string,
): StructuredToolRisk {
  return {
    ...risk,
    requiresConfirmation: true,
    reasons: [reason, ...risk.reasons],
  };
}

function readCommand(input: unknown): string | undefined {
  return isRecord(input) ? readString(input.command) : undefined;
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(^|\/)\.env(\.|$)/i.test(normalized) ||
    /(^|\/)\.git(\/|$)/i.test(normalized) ||
    /(^|\/)config\/.*\.json$/i.test(normalized) ||
    /(id_rsa|credentials|secrets?|token|password|private[-_]?key)/i.test(normalized);
}
