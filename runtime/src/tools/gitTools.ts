import { z } from "zod";

import { DEFAULT_GIT_DIFF_MAX_BYTES } from "./constants.js";
import { truncateDiff } from "./file/diff.js";
import { resolveInsideWorkspace } from "./pathSafe.js";
import { requireProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { Tool } from "./types.js";

function parseGitStatusShort(raw: string): Array<{ path: string; status: string }> {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("##"));
  return lines.map((line) => {
    const status = line.slice(0, 2).trim() || "?";
    const filePath = line.slice(3).trim();
    return { path: filePath, status };
  });
}

function parseGitBranch(raw: string): string | undefined {
  const first = raw.split(/\r?\n/)[0] ?? "";
  const m = first.match(/^## ([^\s.]+)/);
  return m?.[1];
}

/** git_status：查看仓库状态。 */
export const gitStatusTool: Tool<
  z.ZodObject<{ cwd: z.ZodOptional<z.ZodString> }>,
  {
    branch?: string;
    isRepo: boolean;
    changedFiles: Array<{ path: string; status: string }>;
    raw: string;
  }
> = {
  name: "git_status",
  description: "查看 git 仓库状态（git status --short --branch）。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({ cwd: z.string().optional() }),
  async execute(input, ctx) {
    const cwd = input.cwd ? resolveInsideWorkspace(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot;
    try {
      const result = await requireProcessSandbox(ctx.processSandbox).runFile({
        file: "git",
        args: ["status", "--short", "--branch"],
        cwd,
        workspaceRoot: ctx.workspaceRoot,
        networkMode: "offline",
        timeoutMs: 15_000,
        maxOutputBytes: 512 * 1024,
        signal: ctx.signal,
      });
      if (result.spawnFailed) throw new Error(result.stderr || "git sandbox process failed to start");
      if (result.timedOut || result.exitCode !== 0) {
        return { isRepo: false, changedFiles: [], raw: result.stderr };
      }
      const stdout = result.stdout;
      return {
        branch: parseGitBranch(stdout),
        isRepo: true,
        changedFiles: parseGitStatusShort(stdout),
        raw: stdout,
      };
    } catch {
      return { isRepo: false, changedFiles: [], raw: "" };
    }
  },
};

/** git_diff：查看 git diff。 */
export const gitDiffTool: Tool<
  z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    staged: z.ZodDefault<z.ZodBoolean>;
    maxBytes: z.ZodOptional<z.ZodNumber>;
  }>,
  { diff: string; truncated: boolean }
> = {
  name: "git_diff",
  description: "查看 git diff；可按 path 过滤或仅看 staged。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    cwd: z.string().optional(),
    path: z.string().optional(),
    staged: z.boolean().default(false),
    maxBytes: z.number().int().positive().optional(),
  }),
  async execute(input, ctx) {
    const cwd = input.cwd ? resolveInsideWorkspace(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot;
    const args = ["diff"];
    if (input.staged) args.push("--staged");
    if (input.path) {
      resolveInsideWorkspace(ctx.workspaceRoot, input.path);
      args.push("--", input.path.replace(/\\/g, "/"));
    }

    const limit = input.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES;
    try {
      const result = await requireProcessSandbox(ctx.processSandbox).runFile({
        file: "git",
        args,
        cwd,
        workspaceRoot: ctx.workspaceRoot,
        networkMode: "offline",
        timeoutMs: 15_000,
        maxOutputBytes: limit,
        signal: ctx.signal,
      });
      if (result.spawnFailed) throw new Error(result.stderr || "git sandbox process failed to start");
      const stdout = result.exitCode === 0 ? result.stdout : result.stderr || result.stdout;
      const { diff, truncated } = truncateDiff(stdout || "（无 diff）", limit);
      return { diff, truncated: truncated || result.truncated };
    } catch (err) {
      const e = err as { stdout?: string; message?: string };
      const raw = e.stdout ?? e.message ?? String(err);
      const { diff, truncated } = truncateDiff(raw, limit);
      return { diff, truncated };
    }
  },
};
