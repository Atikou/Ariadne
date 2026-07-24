import { z } from "zod";

import {
  SandboxExecutionResultSchema,
  SandboxInvocationSchema,
  SandboxModeSchema,
  SandboxNetworkModeSchema,
  SandboxWriteScopeSchema,
  SandboxAuthorizationProofSchema,
  SandboxControlFailureCodeSchema,
  SandboxControlOperationSchema,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  WindowsSandboxSetupRequestSchema,
  WindowsSandboxStatusSchema,
  WindowsSandboxStatusValueSchema,
  type SandboxAuthorizationProof,
  type SandboxControlFailureCode,
  type SandboxControlOperation,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxMode,
  type WindowsSandboxSetupRequest,
  type WindowsSandboxStatus,
} from "./SandboxContracts.js";
import { writeScopeCapabilitySidHash } from "./WriteScopeCapability.js";

const sha256Hex = SandboxAuthorizationProofSchema.shape.policyDigest;

export const SandboxExecutionAuditEventSchema = z
  .object({
    type: z.literal("sandbox_execute_audit"),
    operation: z.literal("execute"),
    executionId: z.string().trim().min(1).max(512),
    invocation: SandboxInvocationSchema,
    cwd: z.string().trim().min(1).max(32_768),
    workspaceRoot: z.string().trim().min(1).max(32_768),
    mode: SandboxModeSchema,
    networkMode: SandboxNetworkModeSchema,
    account: z.enum(["offline", "online", "current-user"]),
    policyDigest: sha256Hex.optional(),
    accountSidHash: sha256Hex.optional(),
    writeScope: z
      .object({
        scopeId: SandboxWriteScopeSchema.shape.scopeId,
        root: SandboxWriteScopeSchema.shape.root,
        capabilitySidHash: sha256Hex.optional(),
      })
      .strict()
      .optional(),
    outcome: z.enum([
      "completed",
      "command_failed",
      "timed_out",
      "cancelled",
      "blocked",
      "failed",
    ]),
    exitCode: z.number().int().optional(),
    errorCode: SandboxExecutionResultSchema.shape.errorCode.optional(),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    spawnFailed: z.boolean(),
    isolationEnforced: z.boolean(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if ((event.policyDigest === undefined) !== (event.accountSidHash === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policyDigest 与 accountSidHash 必须同时出现",
      });
    }
    if (event.policyDigest !== undefined && event.writeScope !== undefined &&
        event.writeScope.capabilitySidHash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writeScope", "capabilitySidHash"],
        message: "已授权 writeScope 必须携带 capability 指纹",
      });
    }
    if (event.policyDigest === undefined && event.writeScope?.capabilitySidHash !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writeScope", "capabilitySidHash"],
        message: "未授权 writeScope 不得携带 capability 指纹",
      });
    }
    const expectedAccount = event.networkMode === "offline" ? "offline" : "online";
    if (event.account !== "current-user" && event.account !== expectedAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["account"],
        message: "账户类别必须与网络模式一致",
      });
    }
    if (event.outcome === "timed_out" && !event.timedOut) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timedOut"], message: "超时终态必须带 timedOut" });
    }
    if (event.outcome === "completed" &&
        (event.spawnFailed || event.timedOut || event.errorCode !== undefined || event.exitCode !== 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "完成终态与执行结果不一致" });
    }
    if (event.outcome === "command_failed" &&
        (event.spawnFailed || event.timedOut || event.errorCode !== undefined ||
          event.exitCode === undefined || event.exitCode === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "命令失败终态与退出码不一致" });
    }
    if (event.outcome === "cancelled" && event.errorCode !== "cancelled") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "取消终态必须来自 cancelled 结果" });
    }
    if (event.outcome === "blocked" && event.errorCode === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "阻断终态必须携带稳定错误码" });
    }
  });
export type SandboxExecutionAuditEvent = z.infer<typeof SandboxExecutionAuditEventSchema>;

export const SandboxControlAuditEventSchema = z
  .object({
    type: z.literal("sandbox_control_audit"),
    operation: SandboxControlOperationSchema,
    expectedProtocolVersion: z.literal(WINDOWS_SANDBOX_PROTOCOL_VERSION),
    stateRoot: WindowsSandboxSetupRequestSchema.shape.stateRoot,
    workspaceRoot: WindowsSandboxSetupRequestSchema.shape.workspaceRoot,
    writableRoots: WindowsSandboxSetupRequestSchema.shape.writableRoots.removeDefault(),
    toolReadRoots: WindowsSandboxSetupRequestSchema.shape.toolReadRoots.removeDefault(),
    readOnlySubpaths: WindowsSandboxSetupRequestSchema.shape.readOnlySubpaths.removeDefault(),
    allowLoopback: z.boolean(),
    mode: z.enum(["read-only", "workspace-write"]),
    outcome: z.enum(["ready", "setup_required", "unsupported", "error", "failed"]),
    status: WindowsSandboxStatusValueSchema.optional(),
    policyDigest: sha256Hex.optional(),
    reasonCode: z.string().regex(/^[a-z0-9_]+$/u).max(128).optional(),
    errorCode: SandboxControlFailureCodeSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.outcome === "failed") {
      if (event.status !== undefined ||
          event.errorCode === undefined ||
          event.policyDigest !== undefined ||
          event.reasonCode !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcome"],
          message: "控制调用失败必须仅携带稳定 transport 错误码",
        });
      }
      return;
    }
    if (event.status !== event.outcome || event.errorCode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "控制结果与审计终态不一致",
      });
    }
    if (event.outcome === "ready" && event.policyDigest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyDigest"],
        message: "ready 审计必须携带 Helper 验证的策略摘要",
      });
    }
    if (event.outcome === "ready" && event.reasonCode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "ready 审计不得携带失败原因",
      });
    }
  });
export type SandboxControlAuditEvent = z.infer<typeof SandboxControlAuditEventSchema>;

export const SandboxAuditEventSchema = z.union([
  SandboxExecutionAuditEventSchema,
  SandboxControlAuditEventSchema,
]);
export type SandboxAuditEvent = z.infer<typeof SandboxAuditEventSchema>;
export type SandboxAuditSink = (event: SandboxAuditEvent) => void;

export type SandboxControlAuditTerminal =
  | { result: WindowsSandboxStatus; errorCode?: never }
  | { result?: never; errorCode: SandboxControlFailureCode };

export function buildSandboxExecutionAuditEvent(
  request: SandboxExecutionRequest,
  result: SandboxExecutionResult,
  authorization?: SandboxAuthorizationProof,
): SandboxExecutionAuditEvent {
  const proof = authorization === undefined
    ? undefined
    : SandboxAuthorizationProofSchema.parse(authorization);
  if (proof && proof.account !== result.isolation.account) {
    throw new Error("sandbox_authorization_account_mismatch");
  }
  if (proof && ((request.writeScope === undefined) !== (proof.writeScope === undefined) ||
      (request.writeScope && proof.writeScope &&
        (request.writeScope.scopeId !== proof.writeScope.scopeId ||
          request.writeScope.root !== proof.writeScope.root ||
          proof.writeScope.capabilitySidHash !== writeScopeCapabilitySidHash(
            request.writeScope.scopeId,
            request.writeScope.root,
          ))))) {
    throw new Error("sandbox_authorization_write_scope_mismatch");
  }
  return SandboxExecutionAuditEventSchema.parse({
    type: "sandbox_execute_audit",
    operation: "execute",
    executionId: request.executionId,
    invocation: request.invocation,
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    mode: request.mode,
    networkMode: request.networkMode,
    account: result.isolation.account,
    policyDigest: proof?.policyDigest,
    accountSidHash: proof?.accountSidHash,
    writeScope: proof?.writeScope ?? request.writeScope,
    outcome: resolveAuditOutcome(result),
    exitCode: result.exitCode,
    errorCode: result.errorCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    spawnFailed: result.spawnFailed,
    isolationEnforced: result.isolation.enforced,
  });
}

export function emitSandboxExecutionAudit(
  sink: SandboxAuditSink | undefined,
  request: SandboxExecutionRequest,
  result: SandboxExecutionResult,
  authorization?: SandboxAuthorizationProof,
): void {
  if (!sink) return;
  try {
    sink(buildSandboxExecutionAuditEvent(request, result, authorization));
  } catch {
    // Observability must never become an execution control-flow edge.
  }
}

export function buildSandboxControlAuditEvent(
  operation: SandboxControlOperation,
  mode: Exclude<SandboxMode, "danger-full-access">,
  request: WindowsSandboxSetupRequest,
  terminal: SandboxControlAuditTerminal,
): SandboxControlAuditEvent {
  const validatedRequest = WindowsSandboxSetupRequestSchema.parse(request);
  if (terminal.result === undefined) {
    return SandboxControlAuditEventSchema.parse({
      ...controlAuditBase(operation, mode, validatedRequest),
      outcome: "failed",
      errorCode: terminal.errorCode,
    });
  }
  const result = WindowsSandboxStatusSchema.parse(terminal.result);
  return SandboxControlAuditEventSchema.parse({
    ...controlAuditBase(operation, mode, validatedRequest),
    outcome: result.status,
    status: result.status,
    policyDigest: result.policyDigest,
    reasonCode: normalizeControlReason(result.reason),
  });
}

export function emitSandboxControlAudit(
  sink: SandboxAuditSink | undefined,
  operation: SandboxControlOperation,
  mode: Exclude<SandboxMode, "danger-full-access">,
  request: WindowsSandboxSetupRequest,
  terminal: SandboxControlAuditTerminal,
): void {
  if (!sink) return;
  try {
    sink(buildSandboxControlAuditEvent(operation, mode, request, terminal));
  } catch {
    // Observability must never become a maintenance control-flow edge.
  }
}

function resolveAuditOutcome(result: SandboxExecutionResult): SandboxExecutionAuditEvent["outcome"] {
  if (result.timedOut) return "timed_out";
  if (result.errorCode === "cancelled") return "cancelled";
  if (result.errorCode === "setup_required" ||
      result.errorCode === "helper_unavailable" ||
      result.errorCode === "unsupported_platform" ||
      result.errorCode === "invalid_request") {
    return "blocked";
  }
  if (result.spawnFailed || result.errorCode !== undefined || result.exitCode === undefined) return "failed";
  return result.exitCode === 0 ? "completed" : "command_failed";
}

function controlAuditBase(
  operation: SandboxControlOperation,
  mode: Exclude<SandboxMode, "danger-full-access">,
  request: WindowsSandboxSetupRequest,
): Pick<
  SandboxControlAuditEvent,
  | "type"
  | "operation"
  | "expectedProtocolVersion"
  | "stateRoot"
  | "workspaceRoot"
  | "writableRoots"
  | "toolReadRoots"
  | "readOnlySubpaths"
  | "allowLoopback"
  | "mode"
> {
  return {
    type: "sandbox_control_audit",
    operation,
    expectedProtocolVersion: WINDOWS_SANDBOX_PROTOCOL_VERSION,
    stateRoot: request.stateRoot,
    workspaceRoot: request.workspaceRoot,
    writableRoots: request.writableRoots,
    toolReadRoots: request.toolReadRoots,
    readOnlySubpaths: request.readOnlySubpaths,
    allowLoopback: request.allowLoopback,
    mode,
  };
}

function normalizeControlReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const stablePrefix = reason.trim().toLowerCase().match(/^([a-z0-9_]+)/u)?.[1];
  return stablePrefix && stablePrefix.length <= 128 ? stablePrefix : "unclassified";
}
