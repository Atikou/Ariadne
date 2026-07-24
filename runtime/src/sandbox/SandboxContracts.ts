import { Buffer } from "node:buffer";
import path from "node:path";

import { z } from "zod";

import { isSandboxEnvironmentVariableAllowed } from "./SandboxEnvironment.js";

const nonEmptyString = z.string().trim().min(1);
const absolutePath = nonEmptyString.max(32_768).refine((value) => path.isAbsolute(value), {
  message: "路径必须是绝对路径",
});
const accountName = nonEmptyString
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, "沙箱账户名只能包含字母、数字、下划线和连字符");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 5 as const;
export const WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_SANDBOX_BROKER_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const SANDBOX_MAX_STDIN_BYTES = 1024 * 1024;
export const SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES = 64 * 1024;
export const SANDBOX_MAX_STDIN_BASE64_CHARACTERS =
  4 * Math.ceil(SANDBOX_MAX_STDIN_BYTES / 3);

const sandboxStdinBase64 = z
  .string()
  .max(SANDBOX_MAX_STDIN_BASE64_CHARACTERS)
  .superRefine((value, ctx) => {
    if (value.length > SANDBOX_MAX_STDIN_BASE64_CHARACTERS) return;
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength > SANDBOX_MAX_STDIN_BYTES ||
        decoded.toString("base64") !== value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdinBase64 必须是规范 Base64，且解码后不得超过 1 MiB",
      });
    }
  });

export const SandboxControlOperationSchema = z.enum(["status", "setup"]);
export type SandboxControlOperation = z.infer<typeof SandboxControlOperationSchema>;

export const SandboxControlFailureCodeSchema = z.enum([
  "request_invalid",
  "helper_unavailable",
  "helper_failed",
  "helper_timed_out",
  "helper_output_limit",
  "invalid_response",
]);
export type SandboxControlFailureCode = z.infer<typeof SandboxControlFailureCodeSchema>;

export const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const SandboxNetworkModeSchema = z.enum(["offline", "online-approved"]);
export type SandboxNetworkMode = z.infer<typeof SandboxNetworkModeSchema>;

export const SandboxResourceLimitsSchema = z
  .object({
    maxProcesses: z.number().int().min(1).max(128).default(32),
    maxMemoryBytes: z.number().int().min(64 * 1024 * 1024).max(16 * 1024 ** 3).optional(),
    maxCpuTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
  })
  .strict();
export type SandboxResourceLimits = z.infer<typeof SandboxResourceLimitsSchema>;

export const SandboxInvocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      file: nonEmptyString.max(32_768),
      args: z.array(z.string().max(32_768)).max(4_096).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shell"),
      command: nonEmptyString.max(7_500),
    })
    .strict(),
]);
export type SandboxInvocation = z.infer<typeof SandboxInvocationSchema>;

export const SandboxWriteScopeSchema = z
  .object({
    scopeId: z.string().regex(/^[0-9a-f]{32}$/u),
    root: absolutePath,
  })
  .strict();
export type SandboxWriteScope = z.infer<typeof SandboxWriteScopeSchema>;

export const SandboxExecutionRequestSchema = z
  .object({
    executionId: nonEmptyString.max(512),
    invocation: SandboxInvocationSchema,
    cwd: absolutePath,
    workspaceRoot: absolutePath,
    writeScope: SandboxWriteScopeSchema.optional(),
    writableRoots: z.array(absolutePath).max(64).default([]),
    toolReadRoots: z.array(absolutePath).max(64).default([]),
    readOnlySubpaths: z.array(absolutePath).max(64).default([]),
    mode: SandboxModeSchema,
    networkMode: SandboxNetworkModeSchema,
    environment: z
      .record(z.string(), z.string().max(32_768))
      .superRefine((environment, ctx) => {
        if (Object.keys(environment).length > 256) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "环境变量不得超过 256 项" });
        }
        let characters = 0;
        for (const [name, value] of Object.entries(environment)) {
          characters += name.length + value.length + 2;
          if (name.length === 0 || name.length > 128 || name.includes("=") || name.includes("\0") ||
              value.includes("\0") || !isSandboxEnvironmentVariableAllowed(name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `不允许传递环境变量：${name}`,
            });
          }
        }
        if (characters > 256 * 1024) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "环境变量总长度超出限制" });
        }
      })
      .default({}),
    timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
    maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024),
    stdinBase64: sandboxStdinBase64.optional(),
    interactive: z.boolean().default(false),
    resourceLimits: SandboxResourceLimitsSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const brokerEnvelope = JSON.stringify({
      version: WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION,
      request,
    });
    if (Buffer.byteLength(brokerEnvelope, "utf8") > WINDOWS_SANDBOX_BROKER_MAX_REQUEST_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Windows 沙箱 broker 请求超过 2 MiB 协议上限",
      });
    }
    if (request.writeScope !== undefined && request.mode !== "workspace-write") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writeScope"],
        message: "writeScope 仅适用于 workspace-write",
      });
    }
    if (request.interactive && request.stdinBase64 !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stdinBase64"],
        message: "interactive execution receives stdin only through authenticated frames",
      });
    }
    if (request.invocation.kind === "file" &&
        request.invocation.args.reduce((total, argument) => total + argument.length + 3, 0) > 30_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invocation", "args"],
        message: "文件调用命令行超出 Windows 限制",
      });
    }
    if (request.mode !== "danger-full-access" && request.networkMode === "online-approved") {
      return;
    }
    if (request.mode === "danger-full-access" && request.networkMode === "offline") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["networkMode"],
        message: "danger-full-access 不得伪装为离线执行",
      });
    }
  });
export type SandboxExecutionRequest = z.infer<typeof SandboxExecutionRequestSchema>;

const interactiveStdinBase64 = z.string().superRefine((value, context) => {
  if (value.length > 4 * Math.ceil(SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES / 3)) {
    context.addIssue({ code: "custom", message: "interactive stdin chunk exceeds 64 KiB" });
    return;
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength > SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES
    || decoded.toString("base64") !== value
  ) {
    context.addIssue({ code: "custom", message: "interactive stdin must be canonical Base64" });
  }
});

export const SandboxInteractiveInputFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdin"),
    executionId: nonEmptyString.max(512),
    dataBase64: interactiveStdinBase64,
  }).strict(),
  z.object({
    type: z.literal("stdin_end"),
    executionId: nonEmptyString.max(512),
  }).strict(),
]);
export type SandboxInteractiveInputFrame = z.infer<typeof SandboxInteractiveInputFrameSchema>;

export const SandboxIsolationSchema = z
  .object({
    backend: z.enum(["windows-native", "host-process"]),
    enforced: z.boolean(),
    mode: SandboxModeSchema,
    networkMode: SandboxNetworkModeSchema,
    account: z.enum(["offline", "online", "current-user"]),
    restrictedToken: z.boolean(),
    filesystemAcl: z.boolean(),
    appContainer: z.boolean(),
    filesystemReadRestricted: z.boolean(),
    credentialIsolation: z.boolean(),
    publicObjectWriteRestricted: z.boolean(),
    firewall: z.boolean(),
    jobObject: z.boolean(),
    privateDesktop: z.boolean(),
    environment: z.literal("allowlist"),
    processTreeTermination: z.boolean(),
  })
  .strict();
export type SandboxIsolation = z.infer<typeof SandboxIsolationSchema>;

export const SandboxExecutionResultSchema = z
  .object({
    executionId: nonEmptyString.max(512),
    exitCode: z.number().int().optional(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    spawnFailed: z.boolean(),
    errorCode: z
      .enum([
        "setup_required",
        "unsupported_platform",
        "invalid_request",
        "helper_unavailable",
        "credential_failure",
        "process_start_failure",
        "sandbox_cleanup_failure",
        "protocol_failure",
        "cancelled",
      ])
      .optional(),
    isolation: SandboxIsolationSchema,
  })
  .strict();
export type SandboxExecutionResult = z.infer<typeof SandboxExecutionResultSchema>;

export const SandboxAuthorizationProofSchema = z
  .object({
    policyDigest: sha256Hex,
    account: z.enum(["offline", "online"]),
    accountSidHash: sha256Hex,
    writeScope: z
      .object({
        scopeId: SandboxWriteScopeSchema.shape.scopeId,
        root: SandboxWriteScopeSchema.shape.root,
        capabilitySidHash: sha256Hex,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SandboxAuthorizationProof = z.infer<typeof SandboxAuthorizationProofSchema>;

export const SandboxProtocolEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("authorized"),
      executionId: nonEmptyString.max(512),
      authorization: SandboxAuthorizationProofSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("started"),
      executionId: nonEmptyString.max(512),
      pid: z.number().int().positive().optional(),
      isolation: SandboxIsolationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("stdout"),
      executionId: nonEmptyString.max(512),
      dataBase64: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stderr"),
      executionId: nonEmptyString.max(512),
      dataBase64: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      executionId: nonEmptyString.max(512),
      result: SandboxExecutionResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      executionId: nonEmptyString.max(512).optional(),
      code: nonEmptyString.max(128),
      message: nonEmptyString.max(8_192),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type SandboxProtocolEvent = z.infer<typeof SandboxProtocolEventSchema>;

export const WindowsSandboxSetupRequestSchema = z
  .object({
    stateRoot: absolutePath,
    workspaceRoot: absolutePath,
    writableRoots: z.array(absolutePath).max(64).default([]),
    toolReadRoots: z.array(absolutePath).max(64).default([]),
    readOnlySubpaths: z.array(absolutePath).max(64).default([]),
    offlineUser: accountName.default("AriadneOffline"),
    onlineUser: accountName.default("AriadneOnline"),
    writerGroup: accountName.default("AriadneWriters"),
    allowLoopback: z.boolean().default(false),
  })
  .strict();
export type WindowsSandboxSetupRequest = z.infer<typeof WindowsSandboxSetupRequestSchema>;

export const WindowsSandboxStatusValueSchema = z.enum([
  "ready",
  "setup_required",
  "unsupported",
  "error",
]);

export const WindowsSandboxStatusSchema = z
  .object({
    status: WindowsSandboxStatusValueSchema,
    version: z.literal(WINDOWS_SANDBOX_PROTOCOL_VERSION),
    policyDigest: sha256Hex.optional(),
    reason: nonEmptyString.max(8_192).optional(),
    offlineUser: accountName.optional(),
    offlineUserSid: nonEmptyString.max(256).optional(),
    onlineUser: accountName.optional(),
    onlineUserSid: nonEmptyString.max(256).optional(),
    writerGroup: accountName.optional(),
    writerGroupSid: nonEmptyString.max(256).optional(),
    filesystemCapabilitySid: nonEmptyString.max(256).optional(),
    firewallRule: nonEmptyString.max(256).optional(),
    workspaceRoot: absolutePath.optional(),
    writableRoots: z.array(absolutePath).max(64).optional(),
    toolReadRoots: z.array(absolutePath).max(64).optional(),
    readOnlySubpaths: z.array(absolutePath).max(64).optional(),
    allowLoopback: z.boolean().optional(),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (status.status === "ready" && status.policyDigest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyDigest"],
        message: "ready 状态必须携带策略摘要",
      });
    }
  });
export type WindowsSandboxStatus = z.infer<typeof WindowsSandboxStatusSchema>;
