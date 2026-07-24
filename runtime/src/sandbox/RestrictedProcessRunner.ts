import { spawn } from "node:child_process";
import process from "node:process";

import { filterSandboxEnvironment } from "./SandboxEnvironment.js";

export interface RestrictedProcessRequest {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string | Buffer;
}

export interface RestrictedShellRequest extends RestrictedProcessRequest {
  command: string;
}

export interface RestrictedFileRequest extends RestrictedProcessRequest {
  file: string;
  args?: string[];
  shell?: boolean | string;
}

export interface RestrictedProcessResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnFailed: boolean;
  isolation: {
    mode: "restricted_process";
    environment: "allowlist";
    processTreeTermination: true;
    osIsolation: false;
  };
}

/**
 * 应用层受限进程 runner。它收敛进程环境和生命周期，但明确不宣称提供 OS 用户/容器隔离。
 */
export class RestrictedProcessRunner {
  runShell(input: RestrictedShellRequest): Promise<RestrictedProcessResult> {
    return this.run({
      ...input,
      file: input.command,
      args: [],
      shell: process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
    });
  }

  runFile(input: RestrictedFileRequest): Promise<RestrictedProcessResult> {
    return this.run({ ...input, args: input.args ?? [] });
  }

  private run(input: RestrictedFileRequest): Promise<RestrictedProcessResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let spawnFailed = false;
      let truncated = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const child = spawn(input.file, input.args ?? [], {
        cwd: input.cwd,
        env: buildRestrictedEnvironment(),
        windowsHide: true,
        detached: process.platform !== "win32",
        shell: input.shell,
        stdio: [input.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      });

      const append = (chunks: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, input.maxOutputBytes - outputBytes);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        if (chunk.byteLength > remaining) truncated = true;
        outputBytes += Math.min(chunk.byteLength, remaining);
      };
      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));

      const finish = (exitCode?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          truncated,
          spawnFailed,
          isolation: {
            mode: "restricted_process",
            environment: "allowlist",
            processTreeTermination: true,
            osIsolation: false,
          },
        });
      };
      const terminate = () => terminateProcessTree(child.pid);
      const abort = () => {
        terminate();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs);

      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });

      child.once("error", (error) => {
        spawnFailed = true;
        append(stderr, Buffer.from(error.message, "utf8"));
        finish(undefined);
      });
      child.once("close", (code) => finish(code ?? undefined));
      if (input.stdin != null) {
        child.stdin?.end(input.stdin);
      }
    });
  }
}

export const defaultRestrictedProcessRunner = new RestrictedProcessRunner();

export function buildRestrictedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = filterSandboxEnvironment(source);
  env.ARIADNE_RESTRICTED_PROCESS = "1";
  return env;
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}
