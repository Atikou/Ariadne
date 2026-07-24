import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ProjectIndex } from "../../context/ProjectIndex.js";
import { extractSymbolsForFile } from "../../context/ProjectIndex.js";
import type { ProjectFileRecord, SymbolSearchMatchMode } from "../../context/projectIndexTypes.js";
import { ExplorationProgressTracker } from "../../agent/ExplorationProgressTracker.js";
import { DEFAULT_READ_MAX_BYTES } from "../constants.js";
import { resolveInsideWorkspace, shouldIgnoreDir } from "../pathSafe.js";
import type { ToolContext } from "../types.js";
import {
  CONFIG_FILE_NAMES,
  SYMBOL_CODE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./locationHeuristics.js";
import type { LocateBudget, LocatedFile, ProjectFileMeta, SearchPlan } from "./locationTypes.js";
import { isRecord, normalizeRelPath, unique, estimateTokens } from "./locationUtils.js";

export async function collectProjectFiles(
  ctx: ToolContext,
  options: {
    root: string;
    maxDepth: number;
    limit: number;
    extraIgnore?: Set<string>;
    includeContent: boolean;
  },
): Promise<{ files: ProjectFileMeta[]; truncated: boolean }> {
  const rootAbs = resolveInsideWorkspace(ctx.workspaceRoot, options.root);
  const files: ProjectFileMeta[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= options.limit) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= options.limit) {
        truncated = true;
        return;
      }
      if (d.isDirectory() && shouldIgnoreDir(d.name, options.extraIgnore)) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < options.maxDepth) await walk(abs, depth + 1);
        continue;
      }
      const ext = path.extname(d.name);
      if (!TEXT_EXTENSIONS.has(ext) && !CONFIG_FILE_NAMES.has(d.name)) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > DEFAULT_READ_MAX_BYTES * 2) continue;
      const rel = path.relative(ctx.workspaceRoot, abs).replace(/\\/g, "/");
      files.push({
        path: rel,
        fileName: d.name,
        extension: ext,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        language: languageFromExt(ext),
        symbols: [],
        imports: [],
        exports: [],
        tags: tagsForPath(rel),
        hash: createHash("sha1").update(`${rel}:${stat.size}:${stat.mtimeMs}`).digest("hex"),
      });
    }
  };
  await walk(rootAbs, 1);
  return { files, truncated };
}

export async function rankCandidates(
  ctx: ToolContext,
  files: ProjectFileMeta[],
  plan: SearchPlan,
  budget: LocateBudget,
  stats: { usedSearchCalls: number; usedReadForLocationCalls: number; visitedFiles: string[] },
  projectIndex?: ProjectIndex,
  projectId = "default",
  resume?: {
    visitedFiles: Set<string>;
    visitedDirs: Set<string>;
    resumeCandidates: Set<string>;
    resumePrimary: Set<string>;
  },
  explorationTracker?: ExplorationProgressTracker,
): Promise<{
  ranked: LocatedFile[];
  semanticHits: Array<{ path: string; score: number }>;
  dependencyRelated: Array<{ path: string; relation: "imports" | "imported_by"; depth: number }>;
  historyFileHits: Array<{ path: string; score: number; source: string; reason: string }>;
}> {
  const ranked: LocatedFile[] = [];
  const semanticHits: Array<{ path: string; score: number }> = [];
  const historyFileHits: Array<{ path: string; score: number; source: string; reason: string }> = [];
  const semanticBoost = new Map<string, number>();
  const historyBoost = new Map<string, number>();
  const recordedPaths = new Set<string>();
  const recordExploration = (input: {
    path: string;
    contentRead: boolean;
    scoreDelta: number;
    skippedDuplicate?: boolean;
  }): void => {
    if (!explorationTracker || recordedPaths.has(input.path)) return;
    recordedPaths.add(input.path);
    explorationTracker.record(input);
  };
  const loweredKeywords = plan.keywords.map((k) => k.toLowerCase());
  const symbolSet = new Set(plan.possibleSymbols.map((s) => s.toLowerCase()));

  if (ctx.projectSemanticIndexer) {
    const query = [plan.goal, ...plan.keywords.slice(0, 6)].join(" ").trim();
    if (query) {
      const hits = await ctx.projectSemanticIndexer.searchFiles({ projectId, query, limit: 10 });
      for (const hit of hits) {
        semanticHits.push({ path: hit.path, score: hit.score });
        semanticBoost.set(hit.path, hit.score * 0.35);
        if (!files.some((f) => f.path === hit.path)) {
          files.push({
            path: hit.path,
            fileName: path.posix.basename(hit.path),
            extension: path.posix.extname(hit.path),
            sizeBytes: 0,
            modifiedAt: new Date(0).toISOString(),
            language: languageFromExt(path.posix.extname(hit.path)),
            symbols: [],
            imports: [],
            exports: [],
            tags: tagsForPath(hit.path),
            hash: `semantic:${hit.path}`,
          });
        }
      }
    }
  }

  if (ctx.historyFileRecaller) {
    const query = [plan.goal, ...plan.keywords.slice(0, 8)].join(" ").trim();
    if (query) {
      const recalled = await ctx.historyFileRecaller.recall({
        projectId,
        query,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        limit: 12,
      });
      for (const hit of recalled.hits) {
        historyFileHits.push({
          path: hit.path,
          score: hit.score,
          source: hit.source,
          reason: hit.reason,
        });
        historyBoost.set(hit.path, hit.score * 0.38);
        if (!files.some((f) => f.path === hit.path)) {
          files.push({
            path: hit.path,
            fileName: path.posix.basename(hit.path),
            extension: path.posix.extname(hit.path),
            sizeBytes: 0,
            modifiedAt: new Date(0).toISOString(),
            language: languageFromExt(path.posix.extname(hit.path)),
            symbols: [],
            imports: [],
            exports: [],
            tags: [...tagsForPath(hit.path), "memory"],
            hash: `history:${hit.path}`,
          });
        }
      }
    }
  }

  if (projectIndex && plan.possibleSymbols.length) {
    const indexedHits = projectIndex.searchSymbols(projectId, ctx.workspaceRoot, plan.possibleSymbols);
    for (const hit of indexedHits) {
      symbolSet.add(hit.symbol.toLowerCase());
      const existing = files.find((f) => f.path === hit.filePath);
      if (!existing) {
        files.push({
          path: hit.filePath,
          fileName: path.posix.basename(hit.filePath),
          extension: path.posix.extname(hit.filePath),
          sizeBytes: 0,
          modifiedAt: new Date(0).toISOString(),
          language: languageFromExt(path.posix.extname(hit.filePath)),
          symbols: [hit.symbol],
          imports: [],
          exports: [],
          tags: tagsForPath(hit.filePath),
          hash: `symbol:${hit.symbol}`,
        });
      } else if (!existing.symbols.includes(hit.symbol)) {
        existing.symbols.push(hit.symbol);
      }
    }
  }
  const pathHints = plan.possiblePaths.map((p) => p.toLowerCase().replace(/\\/g, "/"));
  for (const file of files) {
    const p = file.path.toLowerCase();
    const name = file.fileName.toLowerCase();
    let score = (semanticBoost.get(file.path) ?? 0) + (historyBoost.get(file.path) ?? 0);
    const matchTypes = new Set<LocatedFile["matchTypes"][number]>();
    const reasons: string[] = [];
    if (semanticBoost.has(file.path)) {
      matchTypes.add("memory");
      reasons.push("LanceDB 语义召回");
    }
    if (historyBoost.has(file.path)) {
      matchTypes.add("memory");
      reasons.push("历史任务/项目记忆召回");
    }
    const alreadyVisited = resume?.visitedFiles.has(file.path) ?? false;
    if (resume?.resumePrimary.has(file.path)) {
      score += 0.4;
      matchTypes.add("memory");
      reasons.push("续跑 primary 候选保留");
    } else if (resume?.resumeCandidates.has(file.path)) {
      score += 0.25;
      matchTypes.add("memory");
      reasons.push("续跑 candidate 候选保留");
    }
    for (const hint of pathHints) {
      if (p.includes(hint)) {
        score += 0.35;
        matchTypes.add("path");
        reasons.push(`路径命中 ${hint}`);
      }
    }
    for (const keyword of loweredKeywords) {
      if (p.includes(keyword.toLowerCase()) || name.includes(keyword.toLowerCase())) {
        score += 0.22;
        matchTypes.add("keyword");
        reasons.push(`文件路径/名称命中 ${keyword}`);
      }
    }
    for (const symbol of file.symbols) {
      if (symbolSet.has(symbol.toLowerCase())) {
        score += 0.28;
        matchTypes.add("symbol");
        reasons.push(`索引符号命中 ${symbol}`);
      }
    }
    if (CONFIG_FILE_NAMES.has(file.fileName) || file.tags.includes("entry")) {
      score += 0.12;
      matchTypes.add("importance");
      reasons.push("重要配置或入口文件");
    }
    const allowContentRead =
      !alreadyVisited ||
      symbolSet.size > 0 ||
      resume?.resumePrimary.has(file.path) ||
      resume?.resumeCandidates.has(file.path);
    if (score > 0 || (allowContentRead && stats.usedReadForLocationCalls < budget.maxReadForLocationCalls)) {
      if (alreadyVisited && score > 0) {
        matchTypes.add("recent");
        reasons.push("续跑已访问（跳过重复读内容）");
        recordExploration({ path: file.path, contentRead: false, scoreDelta: score });
      } else if (alreadyVisited) {
        recordExploration({
          path: file.path,
          contentRead: false,
          scoreDelta: 0,
          skippedDuplicate: true,
        });
        continue;
      }
      const contentScore = allowContentRead && !alreadyVisited
        ? await scoreFileContent(ctx, file.path, loweredKeywords, symbolSet)
        : { score: 0, matchTypes: [] as LocatedFile["matchTypes"], reasons: [] as string[] };
      if (contentScore.score > 0) {
        stats.usedSearchCalls = Math.min(budget.maxSearchCalls, stats.usedSearchCalls + 1);
        stats.usedReadForLocationCalls += 1;
        stats.visitedFiles.push(file.path);
        score += contentScore.score;
        for (const t of contentScore.matchTypes) matchTypes.add(t);
        reasons.push(...contentScore.reasons);
        recordExploration({
          path: file.path,
          contentRead: true,
          scoreDelta: contentScore.score,
        });
      }
    }
    if (score > 0) {
      if (!recordedPaths.has(file.path)) {
        recordExploration({ path: file.path, contentRead: false, scoreDelta: score });
      }
      ranked.push({
        path: file.path,
        score: Number(Math.min(0.99, score).toFixed(2)),
        reason: unique(reasons).slice(0, 4).join("；"),
        matchTypes: [...matchTypes],
      });
    }
  }

  const dependencyRelated: Array<{ path: string; relation: "imports" | "imported_by"; depth: number }> = [];
  if (projectIndex && ranked.length) {
    const seeds = ranked.slice(0, 5).map((item) => item.path);
    const neighbors = projectIndex.expandGraphNeighbors(projectId, ctx.workspaceRoot, seeds, {
      maxDepth: 1,
      limit: 16,
    });
    for (const neighbor of neighbors) {
      dependencyRelated.push(neighbor);
      const boost = neighbor.relation === "imported_by" ? 0.22 : 0.18;
      const existingRank = ranked.find((item) => item.path === neighbor.path);
      if (existingRank) {
        existingRank.score = Number(Math.min(0.99, existingRank.score + boost).toFixed(2));
        if (!existingRank.matchTypes.includes("importance")) {
          existingRank.matchTypes.push("importance");
        }
        existingRank.reason = unique([
          existingRank.reason,
          neighbor.relation === "imported_by" ? "被高相关文件 import" : "import 高相关邻居",
        ].filter(Boolean)).slice(0, 4).join("；");
      } else {
        ranked.push({
          path: neighbor.path,
          score: Number(boost.toFixed(2)),
          reason: neighbor.relation === "imported_by" ? "模块依赖图：被 import" : "模块依赖图：import 邻居",
          matchTypes: ["importance"],
        });
      }
    }
  }

  return {
    ranked: ranked
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, budget.maxCandidateFiles),
    semanticHits,
    dependencyRelated,
    historyFileHits,
  };
}

export async function scoreFileContent(
  ctx: ToolContext,
  rel: string,
  keywords: string[],
  symbols: Set<string>,
): Promise<{ score: number; matchTypes: LocatedFile["matchTypes"]; reasons: string[] }> {
  let content = "";
  try {
    const buf = await fs.readFile(resolveInsideWorkspace(ctx.workspaceRoot, rel));
    if (buf.includes(0)) return { score: 0, matchTypes: [], reasons: [] };
    content = buf.toString("utf-8").slice(0, 80_000);
  } catch {
    return { score: 0, matchTypes: [], reasons: [] };
  }
  const lower = content.toLowerCase();
  let score = 0;
  const matchTypes = new Set<LocatedFile["matchTypes"][number]>();
  const reasons: string[] = [];
  const foundKeywords = keywords.filter((k) => lower.includes(k.toLowerCase())).slice(0, 4);
  if (foundKeywords.length) {
    score += Math.min(0.32, foundKeywords.length * 0.08);
    matchTypes.add("keyword");
    reasons.push(`内容命中 ${foundKeywords.join(", ")}`);
  }
  const foundSymbols = [...symbols].filter((s) => lower.includes(s.toLowerCase())).slice(0, 4);
  if (foundSymbols.length) {
    score += Math.min(0.35, foundSymbols.length * 0.12);
    matchTypes.add("symbol");
    reasons.push(`符号命中 ${foundSymbols.join(", ")}`);
  }
  return { score, matchTypes: [...matchTypes], reasons };
}

export function summarizeFile(file: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const symbols = extractImportantSections(content).slice(0, 3).map((s) => s.split("\n")[0]?.trim()).filter(Boolean);
  return `${lines.length} 行，${estimateTokens(content)} tokens 估算${symbols.length ? `，关键定义：${symbols.join(" / ")}` : ""}`;
}

export function extractImportantSections(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const sections: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(export\s+)?(class|function|interface|type|const|enum)\s+[A-Za-z0-9_]+/.test(line)) {
      sections.push(lines.slice(i, Math.min(lines.length, i + 8)).join("\n"));
    }
    if (sections.length >= 8) break;
  }
  return sections;
}

export function buildUnresolvedHints(plan: SearchPlan, located: LocatedFile[]): string[] {
  const text = located.map((f) => `${f.path} ${f.reason}`).join("\n").toLowerCase();
  return [...plan.keywords, ...plan.possibleSymbols]
    .filter((h) => !text.includes(h.toLowerCase()))
    .slice(0, 8);
}

export function rankImportantFiles(paths: string[]): string[] {
  return paths
    .map((p) => ({
      path: p,
      score: CONFIG_FILE_NAMES.has(path.posix.basename(p)) ? 2 : p.startsWith("src/") ? 1 : 0,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((x) => x.path);
}

export function detectProjectType(paths: string[], packageJson: unknown): string {
  if (paths.includes("package.json")) {
    const deps = {
      ...((isRecord(packageJson) && isRecord(packageJson.dependencies)) ? packageJson.dependencies : {}),
      ...((isRecord(packageJson) && isRecord(packageJson.devDependencies)) ? packageJson.devDependencies : {}),
    };
    if ("typescript" in deps || paths.includes("tsconfig.json")) return "typescript_node";
    return "node";
  }
  if (paths.some((p) => p.endsWith(".py"))) return "python";
  return "unknown";
}

export async function readJsonIfExists(ctx: ToolContext, rel: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(resolveInsideWorkspace(ctx.workspaceRoot, rel), "utf-8"));
  } catch {
    return undefined;
  }
}

export function tagsForPath(rel: string): string[] {
  const tags: string[] = [];
  if (rel.startsWith("src/")) tags.push("source");
  if (rel.startsWith("tests/") || rel.includes(".test.")) tags.push("test");
  if (rel.startsWith("docs/") || rel.endsWith(".md")) tags.push("doc");
  if (CONFIG_FILE_NAMES.has(path.posix.basename(rel))) tags.push("entry");
  return tags;
}

export function languageFromExt(ext: string): string {
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".md") return "markdown";
  if (ext === ".json") return "json";
  return ext.replace(/^\./, "") || "text";
}

export async function projectFileMetaFromPath(
  ctx: ToolContext,
  rel: string,
  stat: { size: number; mtime: Date; mtimeMs: number },
): Promise<ProjectFileMeta | null> {
  const pathRel = normalizeRelPath(rel);
  const ext = path.extname(pathRel);
  if (!TEXT_EXTENSIONS.has(ext) && !CONFIG_FILE_NAMES.has(path.posix.basename(pathRel))) {
    return null;
  }
  return {
    path: pathRel,
    fileName: path.posix.basename(pathRel),
    extension: ext,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    language: languageFromExt(ext),
    symbols: [],
    imports: [],
    exports: [],
    tags: tagsForPath(pathRel),
    hash: createHash("sha1").update(`${pathRel}:${stat.size}:${stat.mtimeMs}`).digest("hex"),
  };
}

export async function syncProjectIndex(
  ctx: ToolContext,
  input: {
    projectId: string;
    files: ProjectFileMeta[];
    forceResync?: boolean;
    extractSymbols?: boolean;
    extractDependencies?: boolean;
    pruneMissing?: boolean;
  },
): Promise<
  | {
      stats: { fileCount: number; symbolCount: number; lastIndexedAt?: string };
      sync: Awaited<ReturnType<ProjectIndex["syncFiles"]>>;
    }
  | undefined
> {
  if (!ctx.projectIndex) return undefined;
  const sync = await ctx.projectIndex.syncFiles({
    projectId: input.projectId,
    workspaceRoot: ctx.workspaceRoot,
    files: input.files.map(fileMetaToProjectRecord),
    extractSymbols: input.extractSymbols ?? true,
    extractDependencies: input.extractDependencies ?? true,
    semanticIndexer: ctx.projectSemanticIndexer,
    forceResync: input.forceResync,
    pruneMissing: input.pruneMissing,
  });
  const stats = ctx.projectIndex.getStats(input.projectId, ctx.workspaceRoot);
  return { stats, sync };
}

export async function collectFilesForIndexUpdate(
  ctx: ToolContext,
  options: {
    root: string;
    paths?: string[];
    maxDepth: number;
    limit: number;
    extraIgnore?: Set<string>;
  },
): Promise<{ files: ProjectFileMeta[]; truncated: boolean }> {
  if (!options.paths?.length) {
    return collectProjectFiles(ctx, {
      root: options.root,
      maxDepth: options.maxDepth,
      limit: options.limit,
      extraIgnore: options.extraIgnore,
      includeContent: false,
    });
  }

  const byPath = new Map<string, ProjectFileMeta>();
  let truncated = false;

  for (const raw of options.paths) {
    if (byPath.size >= options.limit) {
      truncated = true;
      break;
    }
    const rel = normalizeRelPath(raw);
    const abs = resolveInsideWorkspace(ctx.workspaceRoot, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const meta = await projectFileMetaFromPath(ctx, rel, stat);
      if (meta) byPath.set(meta.path, meta);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const batch = await collectProjectFiles(ctx, {
      root: rel,
      maxDepth: options.maxDepth,
      limit: Math.max(1, options.limit - byPath.size),
      extraIgnore: options.extraIgnore,
      includeContent: false,
    });
    truncated = truncated || batch.truncated;
    for (const file of batch.files) {
      byPath.set(file.path, file);
      if (byPath.size >= options.limit) {
        truncated = true;
        break;
      }
    }
  }

  return { files: [...byPath.values()], truncated };
}

export function fileMetaToProjectRecord(file: ProjectFileMeta): ProjectFileRecord {
  return {
    path: file.path,
    fileName: file.fileName,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    mtimeMs: file.mtimeMs ?? Date.parse(file.modifiedAt),
    contentHash: file.hash,
    language: file.language,
    tags: file.tags,
  };
}

type SymbolSearchHit = {
  symbol: string;
  kind: string;
  filePath: string;
  line: number;
  matchType: SymbolSearchMatchMode;
};

export async function searchSymbolsFilesystem(
  ctx: ToolContext,
  input: {
    queries: string[];
    match: SymbolSearchMatchMode;
    kinds?: string[];
    root: string;
    pathPrefix?: string;
    maxDepth: number;
    scanLimit: number;
    limit: number;
    excludePaths: Set<string>;
  },
): Promise<{ hits: SymbolSearchHit[]; truncated: boolean }> {
  const collected = await collectProjectFiles(ctx, {
    root: input.root,
    maxDepth: input.maxDepth,
    limit: input.scanLimit,
    includeContent: false,
  });
  const hits: SymbolSearchHit[] = [];
  for (const file of collected.files) {
    if (!SYMBOL_CODE_EXTENSIONS.has(file.extension)) continue;
    if (input.pathPrefix && !file.path.startsWith(input.pathPrefix)) continue;
    const symbols = await extractSymbolsForFile(ctx.workspaceRoot, file.path);
    for (const sym of symbols) {
      if (input.kinds?.length && !input.kinds.includes(sym.kind)) {
        continue;
      }
      if (!symbolMatches(sym.symbol, input.queries, input.match)) continue;
      const key = `${sym.filePath}:${sym.symbol}:${sym.line}`;
      if (input.excludePaths.has(key)) continue;
      hits.push({
        symbol: sym.symbol,
        kind: sym.kind,
        filePath: sym.filePath,
        line: sym.line,
        matchType: inferMatchType(sym.symbol, input.queries, input.match),
      });
      if (hits.length >= input.limit) {
        return { hits, truncated: collected.truncated || collected.files.length >= input.scanLimit };
      }
    }
  }
  return { hits, truncated: collected.truncated };
}

export function mergeSymbolHits(
  indexHits: SymbolSearchHit[],
  filesystemHits: SymbolSearchHit[],
  limit: number,
): SymbolSearchHit[] {
  const merged: SymbolSearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...indexHits, ...filesystemHits]) {
    const key = `${hit.filePath}:${hit.symbol}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function symbolMatches(symbol: string, queries: string[], match: SymbolSearchMatchMode): boolean {
  const lower = symbol.toLowerCase();
  return queries.some((query) => {
    const q = query.toLowerCase();
    if (match === "exact") return lower === q;
    if (match === "prefix") return lower.startsWith(q);
    return lower.includes(q);
  });
}

export function inferMatchType(
  symbol: string,
  queries: string[],
  match: SymbolSearchMatchMode,
): SymbolSearchMatchMode {
  const lower = symbol.toLowerCase();
  for (const query of queries) {
    const q = query.toLowerCase();
    if (match === "exact" && lower === q) return "exact";
    if (match === "prefix" && lower.startsWith(q)) return "prefix";
    if (match === "contains" && lower.includes(q)) return "contains";
  }
  return match;
}
