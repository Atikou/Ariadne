import { spawn, type ChildProcess } from "node:child_process";

import type { SandboxControlFailureCode } from "./SandboxContracts.js";

export const SANDBOX_STATUS_TIMEOUT_MS = 30_000;
export const SANDBOX_SETUP_TIMEOUT_MS = 11 * 60 * 1_000;
export const SANDBOX_CONTROL_MAX_OUTPUT_BYTES = 1024 * 1024;

export class SandboxControlInvocationError extends Error {
  constructor(
    readonly code: SandboxControlFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxControlInvocationError";
  }
}

export interface BoundedJsonHelperRequest {
  executable: string;
  args: string[];
  body: unknown;
  timeoutMs: number;
  maxOutputBytes?: number;
}

/** 调用可信 Helper 的 JSON 控制入口；调用生命周期与输出均由普通用户控制面收敛。 */
export async function invokeBoundedJsonHelper(
  request: BoundedJsonHelperRequest,
): Promise<unknown> {
  const maxOutputBytes = request.maxOutputBytes ?? SANDBOX_CONTROL_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new SandboxControlInvocationError("request_invalid", "sandbox_helper_limits_invalid");
  }
  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(request.body);
  } catch {
    throw new SandboxControlInvocationError("request_invalid", "sandbox_helper_request_not_serializable");
  }
  return await new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(request.executable, request.args, {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: windowsSandboxHelperEnvironment(),
      });
    } catch (error) {
      reject(controlError("helper_unavailable", error));
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const timer = setTimeout(() => {
      fail(new SandboxControlInvocationError(
        "helper_timed_out",
        `sandbox_helper_timed_out_after_${request.timeoutMs}ms`,
      ));
    }, request.timeoutMs);

    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: SandboxControlInvocationError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // The helper may already have exited; the terminal transport error remains authoritative.
      }
      reject(error);
    };
    const appendOutput = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        fail(new SandboxControlInvocationError(
          "helper_output_limit",
          `sandbox_helper_output_exceeded_${maxOutputBytes}_bytes`,
        ));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.once("error", (error) => fail(controlError("helper_unavailable", error)));
    child.stdin?.once("error", (error) => fail(controlError("helper_failed", error)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 8_192);
        fail(new SandboxControlInvocationError(
          "helper_failed",
          detail || `sandbox_helper_exit_${code ?? "unknown"}`,
        ));
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch {
        fail(new SandboxControlInvocationError("invalid_response", "sandbox_helper_invalid_json"));
      }
    });
    child.stdin?.end(`${serializedBody}\n`);
  });
}

export function windowsSandboxHelperEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

function controlError(
  code: SandboxControlFailureCode,
  error: unknown,
): SandboxControlInvocationError {
  return new SandboxControlInvocationError(code, error instanceof Error ? error.message : String(error));
}
