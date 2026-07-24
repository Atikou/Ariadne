import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES,
  SandboxExecutionResultSchema,
  type SandboxExecutionResult,
  type SandboxIsolation,
} from "./SandboxContracts.js";
import type {
  InteractiveProcessSandbox,
  SandboxFileRequest,
  SandboxProcessHandle,
  SandboxProcessLease,
  SandboxProcessObserver,
  SandboxShellRequest,
} from "./ProcessSandbox.js";
import { filterSandboxEnvironment } from "./SandboxEnvironment.js";

/** Explicit current-user backend for danger-full-access and test injection only. */
export class HostProcessSandbox implements InteractiveProcessSandbox {
  readonly mode = "danger-full-access" as const;

  startShell(input: SandboxShellRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    assertDangerFullAccess(input.mode);
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    return this.start({ ...input, file: input.command, args: [], shell }, observer);
  }

  startFile(input: SandboxFileRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    assertDangerFullAccess(input.mode);
    return this.start({ ...input, args: input.args ?? [] }, observer);
  }

  openFileLease(input: SandboxFileRequest, observer?: SandboxProcessObserver): SandboxProcessLease {
    assertDangerFullAccess(input.mode);
    return this.start({ ...input, args: input.args ?? [] }, observer, true);
  }

  runShell(input: SandboxShellRequest): Promise<SandboxExecutionResult> {
    return this.startShell(input).completion;
  }

  runFile(input: SandboxFileRequest): Promise<SandboxExecutionResult> {
    return this.startFile(input).completion;
  }

  private start(
    input: SandboxFileRequest & { args: string[]; shell?: string | boolean },
    observer?: SandboxProcessObserver,
    interactive = false,
  ): SandboxProcessLease {
    const executionId = randomUUID();
    let child: ChildProcess | undefined;
    let cancelRequested = false;
    let stdinEnded = false;
    const completion = new Promise<SandboxExecutionResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let spawnFailed = false;
      let truncated = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const isolation = hostIsolation(input.networkMode ?? "online-approved");

      const append = (
        chunks: Buffer[],
        chunk: Buffer,
        notify: ((chunk: Buffer) => void) | undefined,
      ) => {
        const remaining = Math.max(0, input.maxOutputBytes - outputBytes);
        const accepted = chunk.subarray(0, remaining);
        if (accepted.byteLength > 0) {
          chunks.push(accepted);
          notify?.(accepted);
        }
        if (chunk.byteLength > remaining) truncated = true;
        outputBytes += accepted.byteLength;
      };
      const finish = (exitCode?: number, errorCode?: SandboxExecutionResult["errorCode"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        resolve(SandboxExecutionResultSchema.parse({
          executionId,
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          truncated,
          spawnFailed,
          errorCode,
          isolation,
        }));
      };
      const terminate = () => terminateProcessTree(child);
      const abort = () => {
        cancelRequested = true;
        terminate();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs);

      try {
        child = spawn(input.file, input.args, {
          cwd: input.cwd,
          env: buildSandboxEnvironment(process.env, input.environment),
          windowsHide: true,
          detached: process.platform !== "win32",
          shell: input.shell ?? false,
          stdio: [interactive || input.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch (error) {
        spawnFailed = true;
        append(stderr, Buffer.from(String(error), "utf8"), observer?.onStderr);
        finish(undefined, "process_start_failure");
        return;
      }

      observer?.onStarted?.({ executionId, pid: child.pid });
      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, observer?.onStdout));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, observer?.onStderr));
      child.once("error", (error) => {
        spawnFailed = true;
        append(stderr, Buffer.from(error.message, "utf8"), observer?.onStderr);
        finish(undefined, "process_start_failure");
      });
      child.once("close", (code) => {
        finish(code ?? undefined, cancelRequested ? "cancelled" : undefined);
      });
      if (!interactive && input.stdin != null) child.stdin?.end(input.stdin);

      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    });

    return {
      executionId,
      completion,
      cancel() {
        cancelRequested = true;
        terminateProcessTree(child);
      },
      async writeStdin(chunk) {
        if (!interactive) throw new Error("sandbox_process_not_interactive");
        if (stdinEnded) throw new Error("sandbox_interactive_stdin_ended");
        const bytes = Buffer.from(chunk);
        if (bytes.byteLength > SANDBOX_MAX_INTERACTIVE_STDIN_CHUNK_BYTES) {
          throw new Error("sandbox_interactive_stdin_chunk_exceeds_64_kib");
        }
        await writeChildInput(child, bytes);
      },
      async endStdin() {
        if (!interactive || stdinEnded) return;
        stdinEnded = true;
        child?.stdin?.end();
      },
    };
  }
}

async function writeChildInput(child: ChildProcess | undefined, bytes: Buffer): Promise<void> {
  if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
    throw new Error("sandbox_interactive_stdin_unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    child.stdin!.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function assertDangerFullAccess(mode: SandboxShellRequest["mode"]): void {
  if (mode !== undefined && mode !== "danger-full-access") {
    throw new Error("host_process_backend_requires_danger_full_access");
  }
}

export function buildSandboxEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additions: Readonly<Record<string, string>> | undefined = undefined,
): NodeJS.ProcessEnv {
  const env = filterSandboxEnvironment(source, additions);
  env.ARIADNE_SANDBOX = "host-process";
  return env;
}

function hostIsolation(networkMode: "offline" | "online-approved"): SandboxIsolation {
  return {
    backend: "host-process",
    enforced: false,
    mode: "danger-full-access",
    networkMode,
    account: "current-user",
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
    processTreeTermination: true,
  };
}

function terminateProcessTree(child: ChildProcess | undefined): void {
  const pid = child?.pid;
  if (!pid) {
    child?.kill();
    return;
  }
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
