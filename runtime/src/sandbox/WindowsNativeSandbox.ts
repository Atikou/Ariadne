import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  SANDBOX_MAX_STDIN_BYTES,
  SandboxExecutionRequestSchema,
  SandboxExecutionResultSchema,
  SandboxProtocolEventSchema,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  WindowsSandboxSetupRequestSchema,
  WindowsSandboxStatusSchema,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxIsolation,
  type SandboxMode,
  type SandboxResourceLimits,
  type SandboxAuthorizationProof,
  type SandboxControlFailureCode,
  type SandboxControlOperation,
  type WindowsSandboxSetupRequest,
  type WindowsSandboxStatus,
} from "./SandboxContracts.js";
import {
  emitSandboxControlAudit,
  emitSandboxExecutionAudit,
  type SandboxAuditSink,
} from "./SandboxAudit.js";
import {
  invokeBoundedJsonHelper,
  SANDBOX_SETUP_TIMEOUT_MS,
  SANDBOX_STATUS_TIMEOUT_MS,
  SandboxControlInvocationError,
  windowsSandboxHelperEnvironment,
} from "./SandboxControlClient.js";
import { writeScopeCapabilitySidHash } from "./WriteScopeCapability.js";
import {
  verifySandboxHelperTrust,
  type SandboxHelperTrustMode,
} from "./SandboxHelperTrust.js";
import type {
  ProcessSandbox,
  SandboxFileRequest,
  SandboxProcessHandle,
  SandboxProcessObserver,
  SandboxShellRequest,
} from "./ProcessSandbox.js";

const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
  maxProcesses: 32,
};
const MAX_PROTOCOL_LINE_BYTES = 96 * 1024 * 1024;
const MAX_PROTOCOL_CHUNK_BASE64 = 64 * 1024;

export interface WindowsNativeSandboxOptions {
  helperPath: string;
  stateRoot: string;
  mode: Exclude<SandboxMode, "danger-full-access">;
  writableRoots?: string[];
  toolReadRoots?: string[];
  readOnlySubpaths?: string[];
  allowLoopback?: boolean;
  resourceLimits?: Partial<SandboxResourceLimits>;
  offlineUser?: string;
  onlineUser?: string;
  writerGroup?: string;
  helperTrustMode?: SandboxHelperTrustMode;
  trustedApplicationRoot?: string;
  audit?: SandboxAuditSink;
}

/** TypeScript 控制面只负责严格协议、生命周期和审批后的身份选择；安全边界由原生 helper 执行。 */
export class WindowsNativeSandbox implements ProcessSandbox {
  readonly helperPath: string;
  readonly stateRoot: string;
  readonly mode: Exclude<SandboxMode, "danger-full-access">;
  private readonly writableRoots: string[];
  private readonly toolReadRoots: string[];
  private readonly readOnlySubpaths: string[];
  private readonly allowLoopback: boolean;
  private readonly resourceLimits: SandboxResourceLimits;
  private readonly accountNames: Pick<
    WindowsSandboxSetupRequest,
    "offlineUser" | "onlineUser" | "writerGroup"
  >;
  private readonly audit?: SandboxAuditSink;
  private readonly helperTrustMode: SandboxHelperTrustMode;
  private readonly trustedApplicationRoot?: string;

  constructor(options: WindowsNativeSandboxOptions) {
    if (process.platform !== "win32") {
      throw new Error("windows_native_sandbox_requires_windows");
    }
    this.helperPath = canonicalPath(options.helperPath);
    this.stateRoot = path.resolve(options.stateRoot);
    this.mode = options.mode;
    this.writableRoots = uniquePaths(options.writableRoots ?? []);
    this.toolReadRoots = uniquePaths(options.toolReadRoots ?? []);
    this.readOnlySubpaths = uniquePaths(options.readOnlySubpaths ?? []);
    this.allowLoopback = options.allowLoopback ?? false;
    this.resourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...options.resourceLimits,
    };
    this.accountNames = {
      offlineUser: options.offlineUser ?? "AriadneOffline",
      onlineUser: options.onlineUser ?? "AriadneOnline",
      writerGroup: options.writerGroup ?? "AriadneWriters",
    };
    this.audit = options.audit;
    this.helperTrustMode = options.helperTrustMode ?? "development";
    this.trustedApplicationRoot = options.trustedApplicationRoot;
    if (this.helperTrustMode === "trusted_distribution") {
      const failure = this.helperTrustFailure();
      if (failure) throw new Error(`windows_sandbox_helper_trust_failed:${failure}`);
    }
  }

  startShell(input: SandboxShellRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    return this.start({ kind: "shell", command: input.command }, input, observer);
  }

  startFile(input: SandboxFileRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    return this.start(
      { kind: "file", file: input.file, args: input.args ?? [] },
      input,
      observer,
    );
  }

  runShell(input: SandboxShellRequest): Promise<SandboxExecutionResult> {
    return this.startShell(input).completion;
  }

  runFile(input: SandboxFileRequest): Promise<SandboxExecutionResult> {
    return this.startFile(input).completion;
  }

  async status(workspaceRoot: string): Promise<WindowsSandboxStatus> {
    return await this.runControlOperation("status", workspaceRoot);
  }

  async setup(workspaceRoot: string): Promise<WindowsSandboxStatus> {
    return await this.runControlOperation("setup", workspaceRoot);
  }

  private buildSetupRequest(workspaceRoot: string): WindowsSandboxSetupRequest {
    return WindowsSandboxSetupRequestSchema.parse({
      stateRoot: this.stateRoot,
      workspaceRoot: canonicalPath(workspaceRoot),
      writableRoots: this.writableRoots,
      toolReadRoots: this.toolReadRoots,
      readOnlySubpaths: this.readOnlySubpaths,
      ...this.accountNames,
      allowLoopback: this.allowLoopback,
    });
  }

  private async runControlOperation(
    operation: SandboxControlOperation,
    workspaceRoot: string,
  ): Promise<WindowsSandboxStatus> {
    const request = this.buildSetupRequest(workspaceRoot);
    const helperTrustFailure = this.helperTrustFailure();
    if (helperTrustFailure) {
      const result = WindowsSandboxStatusSchema.parse({
        status: "setup_required",
        version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
        reason: helperTrustFailure === "helper_missing"
          ? "native_helper_missing"
          : `native_helper_trust_failed_${helperTrustFailure}`,
      });
      emitSandboxControlAudit(this.audit, operation, this.mode, request, { result });
      return result;
    }

    try {
      const raw = await invokeBoundedJsonHelper({
        executable: this.helperPath,
        args: [operation, "--state-root", this.stateRoot],
        body: request,
        timeoutMs: operation === "setup" ? SANDBOX_SETUP_TIMEOUT_MS : SANDBOX_STATUS_TIMEOUT_MS,
      });
      const parsed = WindowsSandboxStatusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new SandboxControlInvocationError(
          "invalid_response",
          "sandbox_helper_invalid_status_response",
        );
      }
      emitSandboxControlAudit(this.audit, operation, this.mode, request, { result: parsed.data });
      return parsed.data;
    } catch (error) {
      emitSandboxControlAudit(this.audit, operation, this.mode, request, {
        errorCode: controlFailureCode(error),
      });
      throw error;
    }
  }

  private start(
    invocation: SandboxExecutionRequest["invocation"],
    input: SandboxFileRequest | SandboxShellRequest,
    observer?: SandboxProcessObserver,
  ): SandboxProcessHandle {
    const executionId = randomUUID();
    const request = this.buildExecutionRequest(executionId, invocation, input);
    const helperTrustFailure = this.helperTrustFailure();
    if (helperTrustFailure) {
      const result = failureResult(
        executionId,
        request,
        "helper_unavailable",
        helperTrustFailure === "helper_missing"
          ? `Windows 沙箱 helper 不存在：${this.helperPath}`
          : `windows_sandbox_helper_trust_failed:${helperTrustFailure}`,
      );
      emitSandboxExecutionAudit(this.audit, request, result);
      return immediateResult(executionId, result);
    }

    let helper: ChildProcess | undefined;
    let settled = false;
    let stdoutBuffer = "";
    let authorization: SandboxAuthorizationProof | undefined;
    let startedIsolation: SandboxIsolation | undefined;
    let terminalResult: SandboxExecutionResult | undefined;
    let terminalSeen = false;
    let streamedBytes = 0;
    const streamedStdout: Buffer[] = [];
    const streamedStderr: Buffer[] = [];
    let resolveCompletion!: (result: SandboxExecutionResult) => void;
    const completion = new Promise<SandboxExecutionResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (result: SandboxExecutionResult) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", cancel);
      emitSandboxExecutionAudit(this.audit, request, result, authorization);
      resolveCompletion(SandboxExecutionResultSchema.parse(result));
    };
    const failure = (
      errorCode: SandboxExecutionResult["errorCode"],
      message: string,
    ): SandboxExecutionResult => failureResult(
      executionId,
      request,
      errorCode,
      message,
      startedIsolation ?? unavailableIsolation(request),
      startedIsolation === undefined,
    );
    const protocolFailure = (message: string) => {
      terminalSeen = true;
      terminalResult = failure("protocol_failure", message);
      helper?.kill();
    };
    const consumeLine = (line: string) => {
      if (!line.trim() || settled) return;
      if (terminalSeen) {
        protocolFailure("Windows 沙箱 helper 在终态后继续发送事件");
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        protocolFailure("Windows 沙箱 helper 协议行超出限制");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        protocolFailure("Windows 沙箱 helper 返回了非 JSON 协议数据");
        return;
      }
      const parsed = SandboxProtocolEventSchema.safeParse(decoded);
      if (!parsed.success) {
        protocolFailure("Windows 沙箱 helper 返回了不合法事件");
        return;
      }
      const event = parsed.data;
      if (event.executionId && event.executionId !== executionId) {
        protocolFailure("Windows 沙箱 helper 返回了跨执行事件");
        return;
      }
      if (event.type === "authorized") {
        const expectedAccount = request.networkMode === "offline" ? "offline" : "online";
        if (authorization ||
            startedIsolation ||
            event.authorization.account !== expectedAccount ||
            !authorizationWriteScopeMatches(request, event.authorization)) {
          protocolFailure("Windows 沙箱 helper 返回了重复或不匹配的授权证明");
          return;
        }
        authorization = event.authorization;
      } else if (event.type === "started") {
        if (!authorization ||
            authorization.account !== event.isolation.account ||
            startedIsolation ||
            !nativeIsolationMatches(event.isolation, request)) {
          protocolFailure("Windows 沙箱 helper 返回了重复或不匹配的启动证明");
          return;
        }
        startedIsolation = event.isolation;
        observer?.onStarted?.({ executionId, pid: event.pid });
      } else if (event.type === "stdout" || event.type === "stderr") {
        if (!startedIsolation) {
          protocolFailure("Windows 沙箱 helper 在 started 前发送了输出");
          return;
        }
        const chunk = decodeProtocolChunk(event.dataBase64);
        if (!chunk || streamedBytes + chunk.byteLength > request.maxOutputBytes) {
          protocolFailure("Windows 沙箱 helper 返回了无效或越界的输出块");
          return;
        }
        streamedBytes += chunk.byteLength;
        if (event.type === "stdout") {
          streamedStdout.push(chunk);
          observer?.onStdout?.(chunk);
        } else {
          streamedStderr.push(chunk);
          observer?.onStderr?.(chunk);
        }
      } else if (event.type === "result") {
        const result = event.result;
        if (!authorization ||
            result.executionId !== executionId ||
            (startedIsolation === undefined && !result.spawnFailed) ||
            (startedIsolation !== undefined && (result.spawnFailed ||
              !isolationEquals(result.isolation, startedIsolation))) ||
            (startedIsolation !== undefined &&
              (Buffer.concat(streamedStdout).toString("utf8") !== result.stdout ||
                Buffer.concat(streamedStderr).toString("utf8") !== result.stderr))) {
          protocolFailure("Windows 沙箱 helper 返回了与事件流不一致的结果");
          return;
        }
        terminalSeen = true;
        terminalResult = result;
      } else {
        if (!event.executionId && (authorization || startedIsolation)) {
          protocolFailure("Windows 沙箱 helper 在启动后返回了无执行标识的错误");
          return;
        }
        terminalSeen = true;
        terminalResult = failure(mapNativeErrorCode(event.code), event.message);
      }
    };
    const cancel = () => {
      helper?.kill();
      finish(failure("cancelled", "Windows 沙箱执行已取消"));
    };

    try {
      helper = spawn(this.helperPath, ["execute", "--state-root", this.stateRoot], {
        cwd: input.cwd,
        env: windowsSandboxHelperEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(failure("helper_unavailable", String(error)));
      return { executionId, completion, cancel };
    }

    helper.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        consumeLine(line);
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        protocolFailure("Windows 沙箱 helper 协议缓冲超出限制");
      }
    });
    helper.stderr?.resume();
    helper.once("error", (error) => {
      finish(failure("helper_unavailable", error.message));
    });
    helper.once("close", (code) => {
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.trim());
      if (settled) return;
      if (code !== 0) protocolFailure("Windows 沙箱 helper 异常退出");
      finish(terminalResult ?? failure(
        "protocol_failure",
        "Windows 沙箱 helper 未返回终态事件",
      ));
    });
    helper.stdin?.end(`${JSON.stringify(request)}\n`);

    if (input.signal?.aborted) cancel();
    else input.signal?.addEventListener("abort", cancel, { once: true });
    return { executionId, completion, cancel };
  }

  private buildExecutionRequest(
    executionId: string,
    invocation: SandboxExecutionRequest["invocation"],
    input: SandboxFileRequest | SandboxShellRequest,
  ): SandboxExecutionRequest {
    const requestedMode = input.mode ?? this.mode;
    if (requestedMode === "danger-full-access") {
      throw new Error("danger_full_access_requires_host_process_backend");
    }
    const workspaceRoot = canonicalPath(input.workspaceRoot);
    const cwd = canonicalPath(input.cwd);
    const stdin = input.stdin == null ? undefined : Buffer.from(input.stdin);
    if (stdin && stdin.byteLength > SANDBOX_MAX_STDIN_BYTES) {
      throw new Error("sandbox_stdin_exceeds_1_mib_protocol_limit");
    }
    assertInsideAnyRoot(cwd, [workspaceRoot, ...this.writableRoots, ...(input.writableRoots ?? [])]);
    return SandboxExecutionRequestSchema.parse({
      executionId,
      invocation,
      cwd,
      workspaceRoot,
      writeScope: input.writeScope
        ? {
            scopeId: input.writeScope.scopeId,
            root: canonicalPath(input.writeScope.root),
          }
        : undefined,
      writableRoots: uniquePaths([...this.writableRoots, ...(input.writableRoots ?? [])]),
      toolReadRoots: this.toolReadRoots,
      readOnlySubpaths: uniquePaths([
        ...this.readOnlySubpaths,
        ...(input.readOnlySubpaths ?? []),
      ]),
      mode: requestedMode,
      networkMode: input.networkMode ?? "offline",
      environment: input.environment ?? {},
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      stdinBase64: stdin?.toString("base64"),
      resourceLimits: {
        ...this.resourceLimits,
        ...input.resourceLimits,
      },
    });
  }

  private helperTrustFailure(): string | undefined {
    const result = verifySandboxHelperTrust({
      helperPath: this.helperPath,
      mode: this.helperTrustMode,
      ...(this.trustedApplicationRoot
        ? { applicationRoot: this.trustedApplicationRoot }
        : {}),
    });
    return result.trusted ? undefined : result.reason;
  }
}

function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const canonical = canonicalPath(value);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) seen.set(key, canonical);
  }
  return [...seen.values()];
}

function assertInsideAnyRoot(target: string, roots: readonly string[]): void {
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
  const inside = roots.some((root) => {
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
    const relative = path.relative(rootKey, targetKey);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!inside) throw new Error(`sandbox_cwd_outside_allowed_roots:${target}`);
}

function unavailableIsolation(request: SandboxExecutionRequest): SandboxIsolation {
  return {
    backend: "windows-native",
    enforced: false,
    mode: request.mode,
    networkMode: request.networkMode,
    account: request.networkMode === "offline" ? "offline" : "online",
    restrictedToken: false,
    filesystemAcl: false,
    appContainer: false,
    filesystemReadRestricted: false,
    credentialIsolation: false,
    publicObjectWriteRestricted: false,
    firewall: false,
    jobObject: false,
    privateDesktop: false,
    environment: "allowlist",
    processTreeTermination: false,
  };
}

function failureResult(
  executionId: string,
  request: SandboxExecutionRequest,
  errorCode: SandboxExecutionResult["errorCode"],
  message: string,
  isolation: SandboxIsolation = unavailableIsolation(request),
  spawnFailed = true,
): SandboxExecutionResult {
  return SandboxExecutionResultSchema.parse({
    executionId,
    stdout: "",
    stderr: message,
    timedOut: false,
    truncated: false,
    spawnFailed,
    errorCode,
    isolation,
  });
}

function decodeProtocolChunk(value: string): Buffer | undefined {
  if (value.length > MAX_PROTOCOL_CHUNK_BASE64 ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function nativeIsolationMatches(
  isolation: SandboxIsolation,
  request: SandboxExecutionRequest,
): boolean {
  return isolation.backend === "windows-native" &&
    isolation.enforced === true &&
    isolation.mode === request.mode &&
    isolation.networkMode === request.networkMode &&
    isolation.account === (request.networkMode === "offline" ? "offline" : "online") &&
    isolation.restrictedToken === true &&
    isolation.filesystemAcl === true &&
    isolation.appContainer === true &&
    isolation.filesystemReadRestricted === true &&
    isolation.credentialIsolation === true &&
    isolation.publicObjectWriteRestricted === true &&
    isolation.firewall === (request.networkMode === "offline") &&
    isolation.jobObject === true &&
    isolation.privateDesktop === true &&
    isolation.environment === "allowlist" &&
    isolation.processTreeTermination === true;
}

function authorizationWriteScopeMatches(
  request: SandboxExecutionRequest,
  authorization: SandboxAuthorizationProof,
): boolean {
  if (request.writeScope === undefined) return authorization.writeScope === undefined;
  if (authorization.writeScope === undefined) return false;
  return authorization.writeScope.scopeId === request.writeScope.scopeId &&
    canonicalPath(authorization.writeScope.root) === canonicalPath(request.writeScope.root) &&
    authorization.writeScope.capabilitySidHash === writeScopeCapabilitySidHash(
      request.writeScope.scopeId,
      request.writeScope.root,
    );
}

function isolationEquals(left: SandboxIsolation, right: SandboxIsolation): boolean {
  return left.backend === right.backend &&
    left.enforced === right.enforced &&
    left.mode === right.mode &&
    left.networkMode === right.networkMode &&
    left.account === right.account &&
    left.restrictedToken === right.restrictedToken &&
    left.filesystemAcl === right.filesystemAcl &&
    left.publicObjectWriteRestricted === right.publicObjectWriteRestricted &&
    left.firewall === right.firewall &&
    left.jobObject === right.jobObject &&
    left.privateDesktop === right.privateDesktop &&
    left.environment === right.environment &&
    left.processTreeTermination === right.processTreeTermination;
}

function immediateResult(
  executionId: string,
  result: SandboxExecutionResult,
): SandboxProcessHandle {
  return {
    executionId,
    completion: Promise.resolve(result),
    cancel() {},
  };
}

function mapNativeErrorCode(code: string): SandboxExecutionResult["errorCode"] {
  switch (code) {
    case "setup_required":
    case "unsupported_platform":
    case "invalid_request":
    case "helper_unavailable":
    case "credential_failure":
    case "process_start_failure":
    case "sandbox_cleanup_failure":
    case "protocol_failure":
    case "cancelled":
      return code;
    default:
      return "protocol_failure";
  }
}

function controlFailureCode(error: unknown): SandboxControlFailureCode {
  return error instanceof SandboxControlInvocationError ? error.code : "helper_failed";
}
