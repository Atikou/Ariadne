import { z } from "zod";

import {
  DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
} from "./constants.js";
import { resolveInsideWorkspace } from "./pathSafe.js";
import { classifyShellCommand } from "../policy/ShellPolicy.js";
import type { SandboxIsolation } from "../sandbox/SandboxContracts.js";
import { requireProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { Tool } from "./types.js";

/** 拒绝通过 cd 或绝对路径逃出工作区的简单命令形态。 */
export function assertShellCommandStaysInWorkspace(command: string): void {
  const trimmed = command.trim();
  if (/\bcd\s+\.\./i.test(trimmed) || /\bcd\s+[/~]/i.test(trimmed)) {
    throw new Error("命令不得通过 cd 跳出工作区");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\/(?!\/)/.test(trimmed)) {
    throw new Error("命令不得使用工作区外的绝对路径");
  }
}

function clipOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text ?? "", "utf-8");
  if (buf.byteLength <= maxBytes) return { text: text ?? "", truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

/** shell_run：在工作区内执行 Shell 命令（超时/输出限制/风险拦截）。 */
export const shellRunTool: Tool<
  z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    networkAccess: z.ZodDefault<z.ZodBoolean>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    maxOutputBytes: z.ZodDefault<z.ZodNumber>;
  }>,
  {
    command: string;
    cwd: string;
    exitCode?: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    riskLevel: "low" | "medium" | "high";
    spawnFailed?: boolean;
    isolation: SandboxIsolation;
  }
> = {
  name: "shell_run",
  description: "在工作区内执行 Shell 命令；高风险命令拒绝，输出与超时受限。",
  permission: "shell",
  possiblePermissions: ["shell", "network"],
  resolvePermissions: (input) =>
    (input as { networkAccess?: boolean }).networkAccess
      ? ["shell", "network"]
      : ["shell"],
  hasSideEffect: true,
  timeoutMs: DEFAULT_SHELL_TIMEOUT_MS + 5_000,
  inputSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    networkAccess: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(300_000).default(DEFAULT_SHELL_TIMEOUT_MS),
    maxOutputBytes: z.number().int().positive().max(2_000_000).default(DEFAULT_SHELL_MAX_OUTPUT_BYTES),
  }),
  async execute(input, ctx) {
    const decision = ctx.shellPolicy?.evaluate(input.command);
    if (decision?.blocked) {
      throw new Error(`命令被策略拒绝：${decision.reason ?? decision.verdict.reason}`);
    }
    const baseRisk = classifyShellCommand(input.command);
    const riskLevel = decision?.tier ?? baseRisk.tier;
    if (!decision && baseRisk.blocked) {
      throw new Error(`高风险命令被拒绝：${baseRisk.verdict.reason}`);
    }

    const cwdRel = input.cwd ?? ".";
    const cwd = resolveInsideWorkspace(ctx.workspaceRoot, cwdRel);
    assertShellCommandStaysInWorkspace(input.command);

    const result = await requireProcessSandbox(ctx.processSandbox).runShell({
      command: input.command,
      cwd,
      workspaceRoot: ctx.workspaceRoot,
      networkMode: input.networkAccess ? "online-approved" : "offline",
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      signal: ctx.signal,
    });
    if (result.spawnFailed) throw new Error(result.stderr || "shell process spawn failed");
    const out = clipOutput(result.stdout, input.maxOutputBytes);
    const errOut = clipOutput(result.stderr, input.maxOutputBytes);
    return {
      command: input.command,
      cwd: cwdRel,
      exitCode: result.exitCode ?? 1,
      stdout: out.text,
      stderr: errOut.text,
      timedOut: result.timedOut,
      truncated: result.truncated || out.truncated || errOut.truncated,
      riskLevel,
      spawnFailed: false,
      isolation: result.isolation,
    };
  },
};
