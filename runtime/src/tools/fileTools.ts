import { randomUUID } from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  DEFAULT_GIT_DIFF_MAX_BYTES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_MAX_DEPTH,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_SEARCH_CONTEXT_LINES,
  DEFAULT_SEARCH_MAX_RESULTS,
} from "./constants.js";
import { buildUnifiedDiff, truncateDiff } from "./file/diff.js";
import { hashContent, hashFile } from "./file/hash.js";
import {
  assertIsFile,
  resolveInsideWorkspace,
  resolveInsideWorkspaceAsync,
  shouldIgnoreDir,
} from "./pathSafe.js";
import {
  attachOutcome,
  buildListDirNotFoundOutcome,
  buildNotFoundOutcome,
  buildNoResultsOutcome,
  observationFailure,
  observationSuccess,
  type ToolOutcome,
} from "./toolOutcome.js";
import type { ToolStorage } from "./storage/ToolStorage.js";
import type { Tool, ToolContext } from "./types.js";
import { requireProcessSandbox } from "../sandbox/ProcessSandbox.js";

function relPath(workspaceRoot: string, abs: string): string {
  return path.relative(workspaceRoot, abs).replace(/\\/g, "/") || ".";
}

function readWorkspaceAccessString(ctx: ToolContext, key: string): string | undefined {
  const value = ctx.workspaceAccess?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizedChangePath(ctx: ToolContext, relativePath: string): string {
  try {
    return resolveInsideWorkspace(ctx.workspaceRoot, relativePath);
  } catch {
    return path.resolve(ctx.workspaceRoot, relativePath);
  }
}

function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

async function backupOneFile(
  ctx: ToolContext,
  relativePath: string,
  sha256: string,
  reason: string,
): Promise<{ backupPath: string; backupId: string }> {
  if (!ctx.storage) {
    throw new Error("备份需要 ToolStorage（请通过 createDefaultRegistry 传入 dataDir）");
  }
  const batch = await ctx.storage.createBackupBatch(ctx.workspaceRoot, [relativePath], {
    reason,
    sessionId: ctx.sessionId,
    sha256ByPath: new Map([[relativePath, sha256]]),
  });
  const file = batch.files[0];
  if (!file) throw new Error("备份失败");
  return { backupPath: file.backupPath, backupId: batch.backupId };
}

async function recordChange(
  ctx: ToolContext,
  toolName: string,
  relativePath: string,
  opts: {
    changeId: string;
    beforeHash?: string;
    afterHash: string;
    backupPath?: string;
    diff: string;
  },
): Promise<void> {
  ctx.storage?.insertFileChange({
    id: opts.changeId,
    sessionId: ctx.sessionId,
    toolName,
    path: relativePath,
    workspaceRoot: ctx.workspaceRoot,
    normalizedPath: normalizedChangePath(ctx, relativePath),
    workspaceScopeId: readWorkspaceAccessString(ctx, "workspaceScopeId"),
    grantId: readWorkspaceAccessString(ctx, "grantId"),
    workspaceAccess: ctx.workspaceAccess,
    beforeHash: opts.beforeHash,
    afterHash: opts.afterHash,
    backupPath: opts.backupPath,
    diff: opts.diff,
  });
}

function normalizeReadFileEncoding(value: string): "utf8" | "base64" {
  const lower = value.toLowerCase();
  if (lower === "utf-8" || lower === "utf_8" || lower === "utf8") return "utf8";
  if (lower === "base64") return "base64";
  return value as "utf8" | "base64";
}

/** read_file：读取工作区内文本文件。 */
export const readFileTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    encoding: z.ZodDefault<z.ZodEnum<["utf8", "base64", "utf-8"]>>;
    startLine: z.ZodOptional<z.ZodNumber>;
    endLine: z.ZodOptional<z.ZodNumber>;
    maxBytes: z.ZodOptional<z.ZodNumber>;
  }>,
  Record<string, unknown> & { outcome: ToolOutcome }
> = {
  name: "read_file",
  description: "读取工作区内的文本文件；返回 sha256 供写入时并发校验。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    path: z.string().min(1),
    encoding: z.enum(["utf8", "base64", "utf-8"]).default("utf8"),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
  async execute(input, ctx) {
    const encoding = normalizeReadFileEncoding(input.encoding);
    const displayPath = input.path.replace(/\\/g, "/");
    const full = await resolveInsideWorkspaceAsync(ctx.workspaceRoot, input.path);
    let fileStat;
    try {
      fileStat = await stat(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return attachOutcome({ found: false, path: displayPath }, buildNotFoundOutcome(displayPath));
      }
      throw err;
    }
    if (!fileStat.isFile()) {
      return attachOutcome(
        { found: false, path: displayPath },
        observationFailure("not_a_file", `不是文件：${displayPath}`, { path: displayPath }),
      );
    }
    const buf = await fs.readFile(full);
    const sizeBytes = buf.byteLength;
    const sha256 = hashContent(buf.toString("utf-8"));

    let text = buf.toString("utf-8");
    if (input.startLine != null || input.endLine != null) {
      const lines = text.split(/\r?\n/);
      const start = (input.startLine ?? 1) - 1;
      const end = input.endLine ?? lines.length;
      text = lines.slice(start, end).join("\n");
    }

    const limit = input.maxBytes ?? DEFAULT_READ_MAX_BYTES;
    const { text: clipped, truncated } = truncateOutput(text, limit);
    const content =
      encoding === "base64" ? Buffer.from(clipped, "utf-8").toString("base64") : clipped;

    return attachOutcome(
      {
        found: true,
        path: input.path,
        content,
        sizeBytes,
        encoding,
        truncated,
        lineCount: text.split(/\r?\n/).length,
        sha256,
      },
      observationSuccess(`已读取 ${input.path.replace(/\\/g, "/")}`),
    );
  },
};

/** list_files：列出目录内容（可递归、可限深）。 */
export const listFilesTool: Tool<
  z.ZodObject<{
    root: z.ZodDefault<z.ZodString>;
    recursive: z.ZodDefault<z.ZodBoolean>;
    maxDepth: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
  }>,
  {
    root: string;
    files: Array<{
      path: string;
      type: "file" | "directory";
      sizeBytes?: number;
      modifiedAt?: string;
    }>;
    truncated: boolean;
  }
> = {
  name: "list_files",
  description: "列出工作区目录内容；默认忽略 node_modules/.git/dist 等。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    root: z.string().default("."),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().min(1).max(20).default(DEFAULT_LIST_MAX_DEPTH),
    limit: z.number().int().positive().max(2000).default(DEFAULT_LIST_LIMIT),
  }),
  async execute(input, ctx) {
    const rootAbs = resolveInsideWorkspace(ctx.workspaceRoot, input.root);
    const files: Array<{
      path: string;
      type: "file" | "directory";
      sizeBytes?: number;
      modifiedAt?: string;
    }> = [];
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= input.limit) {
        truncated = true;
        return;
      }
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= input.limit) {
          truncated = true;
          return;
        }
        if (shouldIgnoreDir(d.name)) continue;
        const abs = path.join(dir, d.name);
        const rel = relPath(ctx.workspaceRoot, abs);
        if (d.isDirectory()) {
          files.push({ path: rel, type: "directory" });
          if (input.recursive && depth < input.maxDepth) {
            await walk(abs, depth + 1);
          }
        } else {
          let sizeBytes: number | undefined;
          let modifiedAt: string | undefined;
          try {
            const st = statSync(abs);
            sizeBytes = st.size;
            modifiedAt = st.mtime.toISOString();
          } catch {
            /* ignore */
          }
          files.push({ path: rel, type: "file", sizeBytes, modifiedAt });
        }
      }
    };

    try {
      await walk(rootAbs, 1);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return attachOutcome(
          { root: input.root, files: [], truncated: false, found: false },
          buildListDirNotFoundOutcome(input.root),
        );
      }
      throw err;
    }
    const outcome =
      files.length === 0 && !truncated
        ? observationFailure("no_results", `目录「${input.root}」为空`, {
            path: input.root.replace(/\\/g, "/"),
          })
        : observationSuccess(`列出 ${files.length} 个条目（root=${input.root}）`);
    return attachOutcome({ root: input.root, files, truncated }, outcome);
  },
};

/** search_text：在工作区内搜索文本。 */
export const searchTextTool: Tool<
  z.ZodObject<{
    query: z.ZodString;
    root: z.ZodDefault<z.ZodString>;
    dir: z.ZodOptional<z.ZodString>;
    regex: z.ZodDefault<z.ZodBoolean>;
    caseSensitive: z.ZodDefault<z.ZodBoolean>;
    maxResults: z.ZodDefault<z.ZodNumber>;
    contextLines: z.ZodDefault<z.ZodNumber>;
  }>,
  {
    query: string;
    results: Array<{
      path: string;
      line: number;
      text: string;
      before?: string[];
      after?: string[];
    }>;
    truncated: boolean;
  }
> = {
  name: "search_text",
  description: "在工作区内搜索文本，返回路径、行号与上下文。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 15_000,
  inputSchema: z.object({
    query: z.string().min(1),
    root: z.string().default("."),
    dir: z.string().optional(),
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().positive().max(500).default(DEFAULT_SEARCH_MAX_RESULTS),
    contextLines: z.number().int().min(0).max(10).default(DEFAULT_SEARCH_CONTEXT_LINES),
  }),
  async execute(input, ctx) {
    const searchRoot = resolveInsideWorkspace(ctx.workspaceRoot, input.dir ?? input.root);
    const results: Array<{
      path: string;
      line: number;
      text: string;
      before?: string[];
      after?: string[];
    }> = [];
    let truncated = false;

    const flags = input.caseSensitive ? "g" : "gi";
    const matcher = input.regex
      ? new RegExp(input.query, flags)
      : null;

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= input.maxResults) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        if (ctx.signal?.aborted) return;
        if (results.length >= input.maxResults) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (shouldIgnoreDir(d.name)) continue;
          await walk(abs);
        } else {
          let content: string;
          try {
            const buf = await fs.readFile(abs);
            if (buf.includes(0)) continue;
            content = buf.toString("utf-8");
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]!;
            const hit = matcher ? matcher.test(line) : line.includes(input.query);
            if (hit) {
              const before =
                input.contextLines > 0
                  ? lines.slice(Math.max(0, i - input.contextLines), i)
                  : undefined;
              const after =
                input.contextLines > 0
                  ? lines.slice(i + 1, i + 1 + input.contextLines)
                  : undefined;
              results.push({
                path: relPath(ctx.workspaceRoot, abs),
                line: i + 1,
                text: line.slice(0, 500),
                before,
                after,
              });
              if (results.length >= input.maxResults) {
                truncated = true;
                break;
              }
            }
          }
        }
      }
    };

    await walk(searchRoot);
    const root = input.dir ?? input.root;
    const outcome =
      results.length === 0
        ? buildNoResultsOutcome(input.query, root)
        : observationSuccess(`搜索「${input.query}」命中 ${results.length} 条`);
    return attachOutcome({ query: input.query, root, results, truncated }, outcome);
  },
};

/** write_file：创建或整文件覆盖（修改已有文件优先 apply_patch）。 */
export const writeFileTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    createOnly: z.ZodDefault<z.ZodBoolean>;
    overwrite: z.ZodDefault<z.ZodBoolean>;
    expectedHash: z.ZodOptional<z.ZodString>;
    backup: z.ZodDefault<z.ZodBoolean>;
    createDirs: z.ZodDefault<z.ZodBoolean>;
  }>,
  {
    path: string;
    changeId: string;
    beforeHash?: string;
    afterHash: string;
    backupPath?: string;
    diff: string;
    patchPreview: string;
    isNew: boolean;
  }
> = {
  name: "write_file",
  description: "写入工作区文件；默认备份并返回 diff。修改已有文件建议用 apply_patch。",
  permission: "write",
  hasSideEffect: true,
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    createOnly: z.boolean().default(false),
    overwrite: z.boolean().default(true),
    expectedHash: z.string().optional(),
    backup: z.boolean().default(true),
    createDirs: z.boolean().default(true),
  }),
  async execute(input, ctx) {
    const full = resolveInsideWorkspace(ctx.workspaceRoot, input.path);
    let oldContent: string | null = null;
    let beforeHash: string | undefined;
    try {
      oldContent = await fs.readFile(full, "utf-8");
      beforeHash = hashContent(oldContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (oldContent !== null && input.createOnly) {
      throw new Error(`文件已存在且 createOnly=true：${input.path}`);
    }
    if (oldContent !== null && !input.overwrite) {
      throw new Error(`文件已存在且 overwrite=false：${input.path}`);
    }
    if (input.expectedHash != null && beforeHash != null && beforeHash !== input.expectedHash) {
      throw new Error(`expectedHash 不匹配，文件可能已被修改：${input.path}`);
    }

    const diff = buildUnifiedDiff(oldContent ?? "", input.content, input.path);
    const changeId = randomUUID();
    let backupPath: string | undefined;

    if (input.backup && oldContent !== null && ctx.storage) {
      const batch = await backupOneFile(ctx, input.path, beforeHash!, "write_file");
      backupPath = batch.backupPath;
    }

    try {
      if (input.createDirs) {
        await fs.mkdir(path.dirname(full), { recursive: true });
      }
      await fs.writeFile(full, input.content, "utf-8");
    } catch (writeErr) {
      if (
        (writeErr as NodeJS.ErrnoException).code === "ENOENT" &&
        !input.createDirs &&
        oldContent === null
      ) {
        try {
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, input.content, "utf-8");
        } catch (retryErr) {
          if (backupPath && oldContent !== null) {
            await ctx.storage!.restoreFileFromBackup(backupPath, full);
          }
          throw retryErr;
        }
      } else {
        if (backupPath && oldContent !== null) {
          await ctx.storage!.restoreFileFromBackup(backupPath, full);
        }
        throw writeErr;
      }
    }

    const afterHash = hashContent(input.content);
    await recordChange(ctx, "write_file", input.path, {
      changeId,
      beforeHash,
      afterHash,
      backupPath,
      diff,
    });

    return {
      path: input.path,
      changeId,
      beforeHash,
      afterHash,
      backupPath,
      diff,
      patchPreview: diff,
      isNew: oldContent === null,
    };
  },
};

/** apply_patch：search/replace 唯一匹配的安全修改。 */
export const applyPatchTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    search: z.ZodString;
    replace: z.ZodString;
    expectedHash: z.ZodOptional<z.ZodString>;
    backup: z.ZodDefault<z.ZodBoolean>;
  }>,
  {
    path: string;
    changeId: string;
    beforeHash: string;
    afterHash: string;
    backupPath: string;
    diff: string;
  }
> = {
  name: "apply_patch",
  description: "对已有文件做 search/replace；search 必须唯一匹配，默认备份并返回 diff。",
  permission: "write",
  hasSideEffect: true,
  inputSchema: z.object({
    path: z.string().min(1),
    search: z.string().min(1),
    replace: z.string(),
    expectedHash: z.string().optional(),
    backup: z.boolean().default(true),
  }),
  async execute(input, ctx) {
    const full = await resolveInsideWorkspaceAsync(ctx.workspaceRoot, input.path);
    await assertIsFile(full, input.path);
    const oldContent = await fs.readFile(full, "utf-8");
    const beforeHash = hashContent(oldContent);

    if (input.expectedHash != null && beforeHash !== input.expectedHash) {
      throw new Error(`expectedHash 不匹配：${input.path}`);
    }

    const first = oldContent.indexOf(input.search);
    if (first === -1) {
      throw new Error(`search 未找到：${input.path}`);
    }
    const last = oldContent.indexOf(input.search, first + input.search.length);
    if (last !== -1) {
      throw new Error(`search 匹配多处（${input.path}），拒绝修改`);
    }

    const newContent =
      oldContent.slice(0, first) + input.replace + oldContent.slice(first + input.search.length);
    const diff = buildUnifiedDiff(oldContent, newContent, input.path);
    const changeId = randomUUID();

    if (!ctx.storage) {
      throw new Error("apply_patch 需要 ToolStorage");
    }

    let backupPath = "";
    if (input.backup) {
      const batch = await backupOneFile(ctx, input.path, beforeHash, "apply_patch");
      backupPath = batch.backupPath;
    }

    try {
      await fs.writeFile(full, newContent, "utf-8");
    } catch (writeErr) {
      if (backupPath) {
        await ctx.storage.restoreFileFromBackup(backupPath, full);
      }
      throw writeErr;
    }

    const afterHash = hashContent(newContent);
    await recordChange(ctx, "apply_patch", input.path, {
      changeId,
      beforeHash,
      afterHash,
      backupPath,
      diff,
    });

    return { path: input.path, changeId, beforeHash, afterHash, backupPath, diff };
  },
};

/** diff_file：对比文件与备份/git/临时内容。 */
export const diffFileTool: Tool<
  z.ZodObject<{
    path: z.ZodString;
    against: z.ZodDefault<z.ZodEnum<["backup", "git", "content"]>>;
    changeId: z.ZodOptional<z.ZodString>;
    oldContent: z.ZodOptional<z.ZodString>;
    newContent: z.ZodOptional<z.ZodString>;
  }>,
  { path: string; diff: string; truncated: boolean }
> = {
  name: "diff_file",
  description: "查看文件 diff：对比备份（changeId）、git 工作区或临时内容。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: z.object({
    path: z.string().min(1),
    against: z.enum(["backup", "git", "content"]).default("git"),
    changeId: z.string().optional(),
    oldContent: z.string().optional(),
    newContent: z.string().optional(),
  }),
  async execute(input, ctx) {
    const full = resolveInsideWorkspace(ctx.workspaceRoot, input.path);
    let diff = "";

    if (input.against === "content") {
      diff = buildUnifiedDiff(input.oldContent ?? "", input.newContent ?? "", input.path);
    } else if (input.against === "backup") {
      if (!ctx.storage || !input.changeId) {
        throw new Error("against=backup 需要 changeId 与 ToolStorage");
      }
      const change = ctx.storage.getFileChange(input.changeId);
      if (!change?.backupPath) throw new Error(`未找到 changeId 备份：${input.changeId}`);
      const old = await ctx.storage.readBackupContent(change.backupPath);
      const current = await fs.readFile(full, "utf-8");
      diff = buildUnifiedDiff(old, current, input.path);
    } else {
      const rel = input.path.replace(/\\/g, "/");
      try {
        const result = await requireProcessSandbox(ctx.processSandbox).runFile({
          file: "git",
          args: ["diff", "--", rel],
          cwd: ctx.workspaceRoot,
          workspaceRoot: ctx.workspaceRoot,
          networkMode: "offline",
          timeoutMs: 15_000,
          maxOutputBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
          signal: ctx.signal,
        });
        diff = result.exitCode === 0
          ? result.stdout || "（无 git diff 输出）"
          : result.stderr || result.stdout;
      } catch (err) {
        const e = err as { stdout?: string; message?: string };
        diff = e.stdout ?? e.message ?? String(err);
      }
    }

    const { diff: out, truncated } = truncateDiff(diff);
    return { path: input.path, diff: out, truncated };
  },
};

/** backup_file：手动备份一个或多个文件。 */
export const backupFileTool: Tool<
  z.ZodObject<{ paths: z.ZodArray<z.ZodString>; reason: z.ZodOptional<z.ZodString> }>,
  {
    backupId: string;
    files: Array<{ path: string; backupPath: string; sha256: string }>;
  }
> = {
  name: "backup_file",
  description: "手动备份工作区内一个或多个文件到 agent_data/backups/。",
  permission: "write",
  hasSideEffect: true,
  inputSchema: z.object({
    paths: z.array(z.string().min(1)).min(1),
    reason: z.string().optional(),
  }),
  async execute(input, ctx) {
    if (!ctx.storage) throw new Error("backup_file 需要 ToolStorage");
    for (const p of input.paths) {
      resolveInsideWorkspace(ctx.workspaceRoot, p);
    }
    const shaMap = new Map<string, string>();
    for (const p of input.paths) {
      const h = await hashFile(path.join(ctx.workspaceRoot, p));
      if (!h) throw new Error(`文件不存在：${p}`);
      shaMap.set(p, h);
    }
    return ctx.storage.createBackupBatch(ctx.workspaceRoot, input.paths, {
      reason: input.reason ?? "manual",
      sessionId: ctx.sessionId,
      sha256ByPath: shaMap,
    });
  },
};

/** rollback_change：按 changeId 回滚文件修改。 */
export const rollbackChangeTool: Tool<
  z.ZodObject<{ changeId: z.ZodString }>,
  { changeId: string; restoredFiles: string[]; diff: string }
> = {
  name: "rollback_change",
  description: "根据 changeId 从备份恢复文件；恢复前会再次备份当前版本。",
  permission: "write",
  hasSideEffect: true,
  inputSchema: z.object({ changeId: z.string().min(1) }),
  async execute(input, ctx) {
    if (!ctx.storage) throw new Error("rollback_change 需要 ToolStorage");
    const change = ctx.storage.getFileChange(input.changeId);
    if (!change?.backupPath) {
      throw new Error(`未找到 changeId：${input.changeId}`);
    }

    const restoreRoot = change.workspaceRoot ?? ctx.workspaceRoot;
    const rollbackCtx: ToolContext = { ...ctx, workspaceRoot: restoreRoot };
    const full = resolveInsideWorkspace(restoreRoot, change.path);
    let currentContent = "";
    try {
      currentContent = await fs.readFile(full, "utf-8");
      const currentHash = hashContent(currentContent);
      await backupOneFile(rollbackCtx, change.path, currentHash, "rollback_pre_restore");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const backupContent = await ctx.storage.readBackupContent(change.backupPath);
    await ctx.storage.restoreFromBackupPath(restoreRoot, change.path, change.backupPath);

    const rollbackDiff = buildUnifiedDiff(currentContent, backupContent, change.path);
    const newChangeId = randomUUID();
    await recordChange(rollbackCtx, "rollback_change", change.path, {
      changeId: newChangeId,
      beforeHash: currentContent ? hashContent(currentContent) : undefined,
      afterHash: hashContent(backupContent),
      backupPath: change.backupPath,
      diff: rollbackDiff,
    });

    return { changeId: input.changeId, restoredFiles: [change.path], diff: rollbackDiff };
  },
};
