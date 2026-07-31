import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";

import {
  DEFAULT_GIT_DIFF_MAX_BYTES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_MAX_DEPTH,
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
import { WORKSPACE_READ_CONTRACT, WORKSPACE_WRITE_CONTRACT } from "./contractProfiles.js";
import type { ToolContext, ToolContract } from "./types.js";
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
    afterHash?: string;
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

const LARGE_FILE_RANGE_THRESHOLD_BYTES = 64 * 1024;
const READ_CHUNK_MAX_BYTES = 2_400;
const DEFAULT_READ_LINE_COUNT = 200;
const MAX_READ_LINE_COUNT = 1_000;
const MAX_FULL_OVERWRITE_BYTES = 64 * 1024;

async function atomicWriteUtf8(fullPath: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(fullPath),
    `.${path.basename(fullPath)}.ariadne-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, fullPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readByteRange(
  fullPath: string,
  byteOffset: number,
  maxBytes: number,
  sizeBytes: number,
): Promise<{
  bytes: Buffer;
  bytesRead: number;
  nextByteOffset?: number;
  eof: boolean;
}> {
  const handle = await fs.open(fullPath, "r");
  try {
    const available = Math.max(0, sizeBytes - byteOffset);
    const requested = Math.min(maxBytes, available);
    const bytes = Buffer.alloc(requested);
    const { bytesRead } = requested > 0
      ? await handle.read(bytes, 0, requested, byteOffset)
      : { bytesRead: 0 };
    const nextByteOffset = byteOffset + bytesRead;
    const eof = nextByteOffset >= sizeBytes;
    return {
      bytes: bytes.subarray(0, bytesRead),
      bytesRead,
      ...(eof ? {} : { nextByteOffset }),
      eof,
    };
  } finally {
    await handle.close();
  }
}

async function readLineRange(
  fullPath: string,
  startLine: number,
  requestedLineCount: number,
  maxBytes: number,
): Promise<{
  content: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  requestedLineCount: number;
  totalLines: number;
  nextStartLine?: number;
  eof: boolean;
  truncated: boolean;
  requiresByteRange: boolean;
}> {
  const stream = createReadStream(fullPath, { encoding: "utf-8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  const requestedEndLine = startLine + requestedLineCount - 1;
  let totalLines = 0;
  let selectedBytes = 0;
  let endLine = startLine - 1;
  let truncated = false;
  let requiresByteRange = false;
  for await (const line of lines) {
    totalLines += 1;
    if (totalLines < startLine || totalLines > requestedEndLine || truncated) continue;
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf-8");
    if (selectedBytes + separatorBytes + lineBytes > maxBytes) {
      truncated = true;
      if (selected.length === 0) {
        const clipped = Buffer.from(line, "utf-8").subarray(0, maxBytes).toString("utf-8");
        selected.push(clipped);
        selectedBytes = Buffer.byteLength(clipped, "utf-8");
        endLine = totalLines;
        requiresByteRange = true;
      }
      continue;
    }
    selected.push(line);
    selectedBytes += separatorBytes + lineBytes;
    endLine = totalLines;
  }
  const eof = endLine >= totalLines && !requiresByteRange;
  return {
    content: selected.join("\n"),
    startLine,
    endLine,
    lineCount: selected.length,
    requestedLineCount,
    totalLines,
    ...(!eof && !requiresByteRange ? { nextStartLine: Math.max(startLine, endLine + 1) } : {}),
    eof,
    truncated,
    requiresByteRange,
  };
}

const readFileInputSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64", "utf-8"]).default("utf8"),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(MAX_READ_LINE_COUNT).optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().max(READ_CHUNK_MAX_BYTES).default(READ_CHUNK_MAX_BYTES),
}).superRefine((input, context) => {
  if (input.lineCount != null && input.endLine != null) {
    context.addIssue({
      code: "custom",
      path: ["lineCount"],
      message: "lineCount and endLine cannot be used together.",
    });
  }
  if (
    input.byteOffset != null
    && (input.startLine != null || input.endLine != null || input.lineCount != null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["byteOffset"],
      message: "byteOffset cannot be combined with line-based ranges.",
    });
  }
});

/** read_file：读取工作区内文本文件。 */
export const readFileTool: ToolContract<
  typeof readFileInputSchema,
  Record<string, unknown> & { outcome: ToolOutcome }
> = {
  ...WORKSPACE_READ_CONTRACT,
  name: "read_file",
  description:
    "分段读取工作区文件并返回范围、游标与 sha256。大文件必须指定 startLine+lineCount；单行压缩文件使用 byteOffset+maxBytes。",
  inputSchema: readFileInputSchema,
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
    const sizeBytes = fileStat.size;
    const sha256 = await hashFile(full);
    const hasLineRange =
      input.startLine != null || input.endLine != null || input.lineCount != null;
    const hasByteRange = input.byteOffset != null;
    if (
      sizeBytes > LARGE_FILE_RANGE_THRESHOLD_BYTES
      && !hasLineRange
      && !hasByteRange
    ) {
      return attachOutcome(
        {
          found: true,
          path: displayPath,
          content: "",
          sizeBytes,
          encoding,
          sha256,
          rangeRequired: true,
          recommended: {
            startLine: 1,
            lineCount: DEFAULT_READ_LINE_COUNT,
            maxBytes: READ_CHUNK_MAX_BYTES,
          },
        },
        observationFailure(
          "range_required",
          `Large file ${displayPath} requires startLine+lineCount or byteOffset+maxBytes.`,
          {
            path: displayPath,
            suggestedNextActions: [{
              tool: "read_file",
              reason: "Read the first bounded line range.",
              input: {
                path: displayPath,
                startLine: 1,
                lineCount: DEFAULT_READ_LINE_COUNT,
              },
            }],
          },
        ),
      );
    }

    if (encoding === "base64" || hasByteRange) {
      const byteOffset = input.byteOffset ?? 0;
      const range = await readByteRange(full, byteOffset, input.maxBytes, sizeBytes);
      const content = encoding === "base64"
        ? range.bytes.toString("base64")
        : range.bytes.toString("utf-8");
      return attachOutcome(
        {
          found: true,
          path: displayPath,
          content,
          sizeBytes,
          encoding,
          sha256,
          byteOffset,
          bytesRead: range.bytesRead,
          nextByteOffset: range.nextByteOffset,
          eof: range.eof,
          truncated: !range.eof,
        },
        observationSuccess(`已读取 ${displayPath} 的字节范围`),
      );
    }

    const startLine = input.startLine ?? 1;
    const requestedLineCount = input.lineCount
      ?? (input.endLine != null
        ? Math.max(1, input.endLine - startLine + 1)
        : DEFAULT_READ_LINE_COUNT);
    const range = await readLineRange(
      full,
      startLine,
      requestedLineCount,
      input.maxBytes,
    );

    return attachOutcome(
      {
        found: true,
        path: displayPath,
        content: range.content,
        sizeBytes,
        encoding,
        truncated: range.truncated || !range.eof,
        startLine: range.startLine,
        endLine: range.endLine,
        lineCount: range.lineCount,
        requestedLineCount: range.requestedLineCount,
        totalLines: range.totalLines,
        nextStartLine: range.nextStartLine,
        eof: range.eof,
        requiresByteRange: range.requiresByteRange,
        sha256,
      },
      observationSuccess(`已读取 ${displayPath} 的行范围`),
    );
  },
};

/** list_files：列出目录内容（可递归、可限深）。 */
export const listFilesTool: ToolContract<
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
  ...WORKSPACE_READ_CONTRACT,
  name: "list_files",
  description: "列出工作区目录内容；默认忽略 node_modules/.git/dist 等。",
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
export const searchTextTool: ToolContract<
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
  ...WORKSPACE_READ_CONTRACT,
  name: "search_text",
  description: "在工作区内搜索文本，返回路径、行号与上下文。",
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
export const writeFileTool: ToolContract<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    createOnly: z.ZodDefault<z.ZodBoolean>;
    overwrite: z.ZodDefault<z.ZodBoolean>;
    expectedHash: z.ZodOptional<z.ZodString>;
    expectedSha256: z.ZodOptional<z.ZodString>;
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
    diffTruncated: boolean;
    patchPreview: string;
    isNew: boolean;
    changedStartLine: number;
    changedEndLine: number;
  }
> = {
  ...WORKSPACE_WRITE_CONTRACT,
  name: "write_file",
  description:
    "创建小文件或完整替换小文件；替换已有文件必须提供 read_file 返回的 expectedSha256。已有大文件应使用 apply_patch。",
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    createOnly: z.boolean().default(false),
    overwrite: z.boolean().default(true),
    expectedHash: z.string().optional(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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
    const expectedSha256 = input.expectedSha256 ?? input.expectedHash;
    if (oldContent !== null && !expectedSha256) {
      throw new Error(
        `Replacing an existing file requires expectedSha256 from read_file: ${input.path}`,
      );
    }
    if (
      oldContent !== null
      && Buffer.byteLength(oldContent, "utf-8") > MAX_FULL_OVERWRITE_BYTES
    ) {
      throw new Error(
        `write_file refuses to replace an existing file larger than ${MAX_FULL_OVERWRITE_BYTES} bytes; use apply_patch: ${input.path}`,
      );
    }
    if (expectedSha256 != null && beforeHash == null) {
      throw new Error(`expectedSha256 target does not exist: ${input.path}`);
    }
    if (expectedSha256 != null && beforeHash !== expectedSha256) {
      throw new Error(`expectedSha256 mismatch; re-read the target range: ${input.path}`);
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
      await atomicWriteUtf8(full, input.content);
    } catch (writeErr) {
      if (
        (writeErr as NodeJS.ErrnoException).code === "ENOENT" &&
        !input.createDirs &&
        oldContent === null
      ) {
        try {
          await fs.mkdir(path.dirname(full), { recursive: true });
          await atomicWriteUtf8(full, input.content);
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

    const visibleDiff = truncateDiff(diff, 8_000);
    const changedEndLine = Math.max(1, input.content.split(/\r?\n/).length);
    return {
      path: input.path,
      changeId,
      beforeHash,
      afterHash,
      backupPath,
      diff: visibleDiff.diff,
      diffTruncated: visibleDiff.truncated,
      patchPreview: visibleDiff.diff,
      isNew: oldContent === null,
      changedStartLine: 1,
      changedEndLine,
    };
  },
};

/** apply_patch：search/replace 唯一匹配的安全修改。 */
export const applyPatchTool: ToolContract<
  z.ZodObject<{
    path: z.ZodString;
    search: z.ZodString;
    replace: z.ZodString;
    expectedHash: z.ZodOptional<z.ZodString>;
    expectedSha256: z.ZodOptional<z.ZodString>;
    backup: z.ZodDefault<z.ZodBoolean>;
  }>,
  {
    path: string;
    changeId: string;
    beforeHash: string;
    afterHash: string;
    backupPath: string;
    diff: string;
    diffTruncated: boolean;
    changedStartLine: number;
    changedEndLine: number;
  }
> = {
  ...WORKSPACE_WRITE_CONTRACT,
  name: "apply_patch",
  description:
    "按唯一锚点局部修改已有文件；必须提供 read_file 返回的 expectedSha256，默认备份并返回 diff 与新哈希。",
  inputSchema: z.object({
    path: z.string().min(1),
    search: z.string().min(1),
    replace: z.string(),
    expectedHash: z.string().optional(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    backup: z.boolean().default(true),
  }),
  async execute(input, ctx) {
    const full = await resolveInsideWorkspaceAsync(ctx.workspaceRoot, input.path);
    await assertIsFile(full, input.path);
    const oldContent = await fs.readFile(full, "utf-8");
    const beforeHash = hashContent(oldContent);

    const expectedSha256 = input.expectedSha256 ?? input.expectedHash;
    if (!expectedSha256) {
      throw new Error(`apply_patch requires expectedSha256 from read_file: ${input.path}`);
    }
    if (beforeHash !== expectedSha256) {
      throw new Error(`expectedSha256 mismatch; re-read the target range: ${input.path}`);
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
      await atomicWriteUtf8(full, newContent);
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

    const visibleDiff = truncateDiff(diff, 8_000);
    const changedStartLine = oldContent.slice(0, first).split(/\r?\n/).length;
    const replacementLines = Math.max(1, input.replace.split(/\r?\n/).length);
    return {
      path: input.path,
      changeId,
      beforeHash,
      afterHash,
      backupPath,
      diff: visibleDiff.diff,
      diffTruncated: visibleDiff.truncated,
      changedStartLine,
      changedEndLine: changedStartLine + replacementLines - 1,
    };
  },
};

const diffFileInputSchema = z.object({
  path: z.string().min(1),
  against: z.enum(["backup", "git", "content"]).default("git"),
  changeId: z.string().optional(),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
});

/** diff_file：对比文件与备份/git/临时内容。 */
export const diffFileTool: ToolContract<
  typeof diffFileInputSchema,
  { path: string; diff: string; truncated: boolean }
> = {
  ...WORKSPACE_READ_CONTRACT,
  name: "diff_file",
  description: "查看文件 diff：对比备份（changeId）、git 工作区或临时内容。",
  inputSchema: diffFileInputSchema,
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
export const backupFileTool: ToolContract<
  z.ZodObject<{ paths: z.ZodArray<z.ZodString>; reason: z.ZodOptional<z.ZodString> }>,
  {
    backupId: string;
    files: Array<{ path: string; backupPath: string; sha256: string }>;
  }
> = {
  ...WORKSPACE_WRITE_CONTRACT,
  name: "backup_file",
  description: "手动备份工作区内一个或多个文件到 agent_data/backups/。",
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
export const rollbackChangeTool: ToolContract<
  z.ZodObject<{ changeId: z.ZodString }>,
  {
    changeId: string;
    sourceChangeId: string;
    restoredFiles: string[];
    deletedFiles: string[];
    diff: string;
  }
> = {
  ...WORKSPACE_WRITE_CONTRACT,
  name: "rollback_change",
  description: "根据 changeId 从备份恢复文件；恢复前会再次备份当前版本。",
  inputSchema: z.object({ changeId: z.string().min(1) }),
  async execute(input, ctx) {
    if (!ctx.storage) throw new Error("rollback_change 需要 ToolStorage");
    const change = ctx.storage.getFileChange(input.changeId);
    if (!change) {
      throw new Error(`未找到 changeId：${input.changeId}`);
    }

    const restoreRoot = change.workspaceRoot ?? ctx.workspaceRoot;
    const rollbackCtx: ToolContext = { ...ctx, workspaceRoot: restoreRoot };
    const full = resolveInsideWorkspace(restoreRoot, change.path);
    let currentContent: string | undefined;
    let currentHash: string | undefined;
    try {
      currentContent = await fs.readFile(full, "utf-8");
      currentHash = hashContent(currentContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (change.afterHash === undefined) {
      if (currentContent !== undefined) {
        throw new Error(`restore_conflict_expected_missing:${change.path}`);
      }
    } else if (currentHash !== change.afterHash) {
      throw new Error(`restore_conflict_current_hash_mismatch:${change.path}`);
    }

    let currentBackupPath: string | undefined;
    if (currentContent !== undefined && currentHash !== undefined) {
      currentBackupPath = (
        await backupOneFile(rollbackCtx, change.path, currentHash, "rollback_pre_restore")
      ).backupPath;
    }

    let restoredContent: string | undefined;
    if (change.beforeHash === undefined) {
      if (currentContent !== undefined) await fs.unlink(full);
    } else {
      if (!change.backupPath) throw new Error(`restore_backup_missing:${change.path}`);
      restoredContent = await ctx.storage.readBackupContent(change.backupPath);
      if (hashContent(restoredContent) !== change.beforeHash) {
        throw new Error(`restore_backup_hash_mismatch:${change.path}`);
      }
      await ctx.storage.restoreFromBackupPath(restoreRoot, change.path, change.backupPath);
    }

    const rollbackDiff = buildUnifiedDiff(
      currentContent ?? "",
      restoredContent ?? "",
      change.path,
    );
    const newChangeId = randomUUID();
    await recordChange(rollbackCtx, "rollback_change", change.path, {
      changeId: newChangeId,
      beforeHash: currentHash,
      afterHash: restoredContent === undefined ? undefined : hashContent(restoredContent),
      backupPath: currentBackupPath,
      diff: rollbackDiff,
    });

    return {
      changeId: newChangeId,
      sourceChangeId: input.changeId,
      restoredFiles: restoredContent === undefined ? [] : [change.path],
      deletedFiles: restoredContent === undefined ? [change.path] : [],
      diff: rollbackDiff,
    };
  },
};
