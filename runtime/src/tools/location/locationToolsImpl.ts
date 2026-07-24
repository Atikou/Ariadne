import { promises as fs } from "node:fs";
import path from "node:path";

import { projectFileToScanMeta } from "../../context/ProjectIndex.js";
import type { SymbolSearchMatchMode } from "../../context/projectIndexTypes.js";
import { ExplorationProgressTracker, type ExplorationProgressSnapshot } from "../../agent/ExplorationProgressTracker.js";
import { DEFAULT_READ_MAX_BYTES } from "../constants.js";
import { resolveInsideWorkspace } from "../pathSafe.js";
import type { Tool, ToolContext } from "../types.js";
import { classifyPathRisk } from "../../policy/PathRiskClassifier.js";
import { DEFAULT_SOURCE_ROOTS, CONFIG_FILE_NAMES } from "./locationHeuristics.js";
import { analyzeTaskQuery } from "./locationQueryAnalyzer.js";
import type { LocateBudget, ProjectFileMeta, SearchPlan } from "./locationTypes.js";
import { DEFAULT_LOCATE_BUDGET } from "./locationTypes.js";
import type { LocatedFile } from "./locationTypes.js";
import {
  projectScanInputSchema,
  projectIndexUpdateInputSchema,
  locateRelevantFilesInputSchema,
  contextPackInputSchema,
  symbolSearchInputSchema,
} from "./locationSchemas.js";
import {
  buildUnresolvedHints,
  collectFilesForIndexUpdate,
  collectProjectFiles,
  detectProjectType,
  extractImportantSections,
  fileMetaToProjectRecord,
  mergeSymbolHits,
  rankCandidates,
  rankImportantFiles,
  readJsonIfExists,
  searchSymbolsFilesystem,
  summarizeFile,
  syncProjectIndex,
} from "./locationInternals.js";
import { estimateTokens, isRecord, isSearchPlanTaskType, normalizeRelPath, unique } from "./locationUtils.js";

export const projectScanTool: Tool<
  typeof projectScanInputSchema,
  {
    projectType: string;
    sourceRoots: string[];
    configFiles: string[];
    scripts: Record<string, string>;
    importantDirs: string[];
    importantFiles: string[];
    scannedFiles: number;
    truncated: boolean;
    projectIndex?: {
      fileCount: number;
      symbolCount: number;
      upserted: number;
      removed: number;
      symbolsUpdated: number;
      skipped: number;
    };
  }
> = {
  name: "project_scan",
  description: "轻量扫描项目结构、配置文件、源码根和重要入口，避免用低层 list_files 逐级探索。",
  permission: "read",
  hasSideEffect: false,
  inputSchema: projectScanInputSchema,
  async execute(input, ctx) {
    const extraIgnore = new Set(input.exclude);
    const files = await collectProjectFiles(ctx, {
      root: input.root,
      maxDepth: input.maxDepth,
      limit: 800,
      extraIgnore,
      includeContent: false,
    });
    const paths = files.files.map((f) => f.path);
    const sourceRoots = unique(
      paths
        .map((p) => p.split("/")[0] ?? "")
        .filter((p): p is string => Boolean(p) && (DEFAULT_SOURCE_ROOTS as readonly string[]).includes(p)),
    );
    const configFiles = paths.filter((p) => {
      const name = path.posix.basename(p);
      if (name === "package.json" && !input.includePackageJson) return false;
      if (name === "tsconfig.json" && !input.includeTsConfig) return false;
      return CONFIG_FILE_NAMES.has(name) || name.includes("config");
    });
    const importantFiles = rankImportantFiles(paths).slice(0, 24);
    const packageJson = input.includePackageJson ? await readJsonIfExists(ctx, "package.json") : undefined;
    const scripts = isRecord(packageJson) && isRecord(packageJson.scripts)
      ? packageJson.scripts as Record<string, string>
      : {};
    const baseResult = {
      projectType: detectProjectType(paths, packageJson),
      sourceRoots,
      configFiles,
      scripts,
      importantDirs: sourceRoots,
      importantFiles,
      scannedFiles: paths.length,
      truncated: files.truncated,
    };
    if (!ctx.projectIndex) return baseResult;
    const indexResult = await syncProjectIndex(ctx, {
      projectId: "default",
      files: files.files,
      extractSymbols: true,
      extractDependencies: true,
      pruneMissing: true,
    });
    if (!indexResult) return baseResult;
    return {
      ...baseResult,
      projectIndex: {
        fileCount: indexResult.stats.fileCount,
        symbolCount: indexResult.stats.symbolCount,
        ...indexResult.sync,
      },
    };
  },
};

export const projectIndexUpdateTool: Tool<
  typeof projectIndexUpdateInputSchema,
  {
    projectId: string;
    root: string;
    pathsFilter?: string[];
    scannedFiles: number;
    truncated: boolean;
    forceResync: boolean;
    indexStats: {
      fileCount: number;
      symbolCount: number;
      lastIndexedAt?: string;
    };
    sync: {
      upserted: number;
      removed: number;
      symbolsUpdated: number;
      skipped: number;
      dependenciesUpdated?: number;
      exportsUpdated?: number;
      semanticIndexed?: number;
    };
  }
> = {
  name: "project_index_update",
  description:
    "增量刷新 ProjectIndex（路径/mtime/hash、符号、import/export、LanceDB 语义向量）；适合写入文件后局部更新，无需完整 project_scan。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 30_000,
  inputSchema: projectIndexUpdateInputSchema,
  async execute(input, ctx) {
    if (!ctx.projectIndex) {
      throw new Error("ProjectIndex 未启用：需要 dataDir 与 DatabaseManager");
    }
    const extraIgnore = new Set(input.exclude);
    const collected = await collectFilesForIndexUpdate(ctx, {
      root: input.root,
      paths: input.paths,
      maxDepth: input.maxDepth,
      limit: input.limit,
      extraIgnore,
    });
    const indexResult = await syncProjectIndex(ctx, {
      projectId: input.projectId,
      files: collected.files,
      forceResync: input.forceResync,
      extractSymbols: input.extractSymbols,
      extractDependencies: input.extractDependencies,
      pruneMissing: false,
    });
    if (!indexResult) {
      throw new Error("ProjectIndex 同步失败");
    }
    return {
      projectId: input.projectId,
      root: input.root,
      pathsFilter: input.paths?.length ? input.paths.map(normalizeRelPath) : undefined,
      scannedFiles: collected.files.length,
      truncated: collected.truncated,
      forceResync: input.forceResync,
      indexStats: {
        fileCount: indexResult.stats.fileCount,
        symbolCount: indexResult.stats.symbolCount,
        lastIndexedAt: indexResult.stats.lastIndexedAt,
      },
      sync: indexResult.sync,
    };
  },
};

export const locateRelevantFilesTool: Tool<
  typeof locateRelevantFilesInputSchema,
  {
    projectId: string;
    searchPlan: SearchPlan;
    primaryFiles: LocatedFile[];
    candidateFiles: LocatedFile[];
    unresolvedHints: string[];
    confidence: number;
    needsMoreSearch: boolean;
    stopReason: "enough_confidence" | "locate_budget_exhausted" | "no_candidates";
    suggestedAction?: "continue_locating";
    explorationProgress: ExplorationProgressSnapshot;
    semanticHits?: Array<{ path: string; score: number }>;
    dependencyRelated?: Array<{ path: string; relation: "imports" | "imported_by"; depth: number }>;
    historyFileHits?: Array<{ path: string; score: number; source: string; reason: string }>;
    locateStats: {
      usedLocateSteps: number;
      usedSearchCalls: number;
      usedListCalls: number;
      usedReadForLocationCalls: number;
      visitedFiles: string[];
      visitedDirs: string[];
    };
    indexSource: "project_index" | "filesystem";
    locationResume?: {
      mergedSearchPlan: boolean;
      skippedVisitedFiles: number;
      boostedCandidateFiles: number;
    };
  }
> = {
  name: "locate_relevant_files",
  description: "根据任务目标一次性生成搜索计划、合并候选并排序，返回 primaryFiles/candidateFiles。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 20_000,
  inputSchema: locateRelevantFilesInputSchema,
  async execute(input, ctx) {
    const budget = { ...DEFAULT_LOCATE_BUDGET, ...input.locateBudget };
    const resumeCtx = input.resumeContext;
    const basePlan = analyzeTaskQuery(input.goal, input.mode, ctx.workspaceRoot);
    const resumedPlan = resumeCtx?.searchPlan;
    const searchPlan: SearchPlan = {
      ...basePlan,
      goal: resumedPlan?.goal ?? basePlan.goal,
      keywords: unique([
        ...(input.keywords ?? []),
        ...(resumedPlan?.keywords ?? []),
        ...basePlan.keywords,
      ]).slice(0, 20),
      possibleSymbols: unique([
        ...(input.possibleSymbols ?? []),
        ...(resumedPlan?.possibleSymbols ?? []),
        ...basePlan.possibleSymbols,
      ]).slice(0, 16),
      possiblePaths: unique([
        ...(input.possiblePaths ?? []),
        ...(resumedPlan?.possiblePaths ?? []),
        ...basePlan.possiblePaths,
      ]).slice(0, 12),
      exclude: unique([...basePlan.exclude, ...(resumedPlan?.exclude ?? [])]),
      taskType:
        isSearchPlanTaskType(resumedPlan?.taskType) ? resumedPlan.taskType : basePlan.taskType,
    };
    const visitedFiles = new Set(resumeCtx?.visitedFiles ?? []);
    const visitedDirs = new Set(resumeCtx?.visitedDirs ?? []);
    const resumeCandidates = new Set(resumeCtx?.candidateFiles ?? []);
    const resumePrimary = new Set(resumeCtx?.primaryFiles ?? []);
    const explorationTracker = new ExplorationProgressTracker(visitedFiles);
    const stats = {
      usedLocateSteps: 1,
      usedSearchCalls: 0,
      usedListCalls: 0,
      usedReadForLocationCalls: 0,
      visitedFiles: [] as string[],
      visitedDirs: [] as string[],
    };
    let files: { files: ProjectFileMeta[]; truncated: boolean };
    let indexSource: "project_index" | "filesystem" = "filesystem";
    if (ctx.projectIndex?.hasUsableIndex(input.projectId, ctx.workspaceRoot)) {
      const indexed = ctx.projectIndex.listFiles(input.projectId, ctx.workspaceRoot);
      files = { files: indexed.map(projectFileToScanMeta), truncated: false };
      indexSource = "project_index";
      stats.usedListCalls = 0;
    } else {
      files = await collectProjectFiles(ctx, {
        root: ".",
        maxDepth: 8,
        limit: 2000,
        extraIgnore: new Set(searchPlan.exclude),
        includeContent: false,
      });
      stats.usedListCalls = 1;
      if (ctx.projectIndex) {
        await ctx.projectIndex.syncFiles({
          projectId: input.projectId,
          workspaceRoot: ctx.workspaceRoot,
          files: files.files.map(fileMetaToProjectRecord),
          extractSymbols: true,
          extractDependencies: true,
          semanticIndexer: ctx.projectSemanticIndexer,
        });
      }
    }
    stats.visitedDirs = unique(files.files.map((f) => f.path.split("/").slice(0, -1).join("/") || ".")).slice(0, 80);
    const rankResult = await rankCandidates(ctx, files.files, searchPlan, budget, stats, ctx.projectIndex, input.projectId, {
      visitedFiles,
      visitedDirs,
      resumeCandidates,
      resumePrimary,
    }, explorationTracker);
    const ranked = rankResult.ranked;
    const maxPrimary = Math.min(input.limit, budget.maxPrimaryFiles);
    const primaryFiles = ranked.filter((f) => f.score >= 0.7).slice(0, maxPrimary);
    const candidateFiles = ranked
      .filter((f) => !primaryFiles.some((p) => p.path === f.path))
      .slice(0, Math.min(input.limit, budget.maxCandidateFiles));
    explorationTracker.markContributors([
      ...primaryFiles.map((f) => f.path),
      ...candidateFiles.map((f) => f.path),
    ]);
    const explorationProgress = explorationTracker.snapshot();
    const confidence = primaryFiles.length > 0
      ? Math.min(0.98, Math.max(...primaryFiles.map((f) => f.score)))
      : candidateFiles.length > 0
        ? Math.min(0.69, Math.max(...candidateFiles.map((f) => f.score)))
        : 0;
    const needsMoreSearch = confidence < 0.75 || primaryFiles.length < Math.min(3, budget.maxPrimaryFiles);
    const locateBudgetExhausted =
      stats.usedSearchCalls >= budget.maxSearchCalls ||
      stats.usedReadForLocationCalls >= budget.maxReadForLocationCalls ||
      files.truncated;
    const stopReason = primaryFiles.length === 0 && candidateFiles.length === 0
      ? "no_candidates"
      : needsMoreSearch && locateBudgetExhausted
        ? "locate_budget_exhausted"
        : "enough_confidence";
    return {
      projectId: input.projectId,
      searchPlan,
      primaryFiles,
      candidateFiles,
      unresolvedHints: buildUnresolvedHints(searchPlan, [...primaryFiles, ...candidateFiles]),
      confidence,
      needsMoreSearch,
      stopReason,
      suggestedAction: needsMoreSearch ? "continue_locating" : undefined,
      explorationProgress,
      semanticHits: rankResult.semanticHits.length ? rankResult.semanticHits : undefined,
      dependencyRelated: rankResult.dependencyRelated.length ? rankResult.dependencyRelated : undefined,
      historyFileHits: rankResult.historyFileHits.length ? rankResult.historyFileHits : undefined,
      locateStats: stats,
      indexSource,
      locationResume: resumeCtx
        ? {
            mergedSearchPlan: Boolean(resumedPlan),
            skippedVisitedFiles: [...visitedFiles].filter((p) =>
              stats.visitedFiles.includes(p) || ranked.every((r) => r.path !== p),
            ).length,
            boostedCandidateFiles: [...resumeCandidates].filter((p) =>
              ranked.some((r) => r.path === p),
            ).length,
          }
        : undefined,
    };
  },
};

export const symbolSearchTool: Tool<
  typeof symbolSearchInputSchema,
  {
    projectId: string;
    queries: string[];
    symbols: Array<{
      symbol: string;
      kind: string;
      filePath: string;
      line: number;
      matchType: SymbolSearchMatchMode;
    }>;
    indexSource: "project_index" | "filesystem" | "mixed";
    truncated: boolean;
    indexStats?: { fileCount: number; symbolCount: number };
  }
> = {
  name: "symbol_search",
  description:
    "按类名/函数名/类型名搜索符号定义位置；优先查 ProjectIndex，索引未命中时回退扫描源码。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 20_000,
  inputSchema: symbolSearchInputSchema,
  async execute(input, ctx) {
    const queries = unique([
      ...(input.symbols ?? []),
      ...(input.query?.trim() ? [input.query.trim()] : []),
    ]);
    const limit = input.limit;
    const pathPrefix = input.pathPrefix?.replace(/\\/g, "/");

    let indexHits: Array<{
      symbol: string;
      kind: string;
      filePath: string;
      line: number;
      matchType: SymbolSearchMatchMode;
    }> = [];
    let indexStats: { fileCount: number; symbolCount: number } | undefined;

    if (ctx.projectIndex) {
      const stats = ctx.projectIndex.getStats(input.projectId, ctx.workspaceRoot);
      indexStats = { fileCount: stats.fileCount, symbolCount: stats.symbolCount };
      if (stats.symbolCount > 0) {
        indexHits = ctx.projectIndex
          .searchSymbolsQuery({
            projectId: input.projectId,
            workspaceRoot: ctx.workspaceRoot,
            queries,
            match: input.match,
            kinds: input.kinds,
            pathPrefix,
            limit,
          })
          .map((hit) => ({ ...hit, matchType: input.match }));
      }
    }

    let filesystemHits: typeof indexHits = [];
    let truncated = false;
    if (indexHits.length < limit) {
      const scanned = await searchSymbolsFilesystem(ctx, {
        queries,
        match: input.match,
        kinds: input.kinds,
        root: input.root,
        pathPrefix,
        maxDepth: input.maxDepth,
        scanLimit: input.scanLimit,
        limit: limit - indexHits.length,
        excludePaths: new Set(indexHits.map((h) => `${h.filePath}:${h.symbol}:${h.line}`)),
      });
      filesystemHits = scanned.hits;
      truncated = scanned.truncated;
    }

    const merged = mergeSymbolHits(indexHits, filesystemHits, limit);
    const indexSource: "project_index" | "filesystem" | "mixed" =
      indexHits.length > 0 && filesystemHits.length > 0
        ? "mixed"
        : indexHits.length > 0
          ? "project_index"
          : "filesystem";

    return {
      projectId: input.projectId,
      queries,
      symbols: merged,
      indexSource,
      truncated,
      indexStats,
    };
  },
};

export const contextPackTool: Tool<
  typeof contextPackInputSchema,
    {
      files: Array<{
        path: string;
        summary: string;
        content?: string;
        importantSections?: string[];
        truncated: boolean;
      }>;
      combinedSummary: string;
      tokenEstimate: number;
      skippedFiles: string[];
      redactedFiles: Array<{ path: string; reason: string; riskTier: string }>;
      skippedSensitiveFiles: string[];
    }
  > = {
  name: "context_pack",
  description: "一次性读取并摘要多个相关文件，减少连续 read_file 调用。",
  permission: "read",
  hasSideEffect: false,
  timeoutMs: 20_000,
  inputSchema: contextPackInputSchema,
  async execute(input, ctx) {
      const packed = [];
      const skippedFiles: string[] = [];
      const redactedFiles: Array<{ path: string; reason: string; riskTier: string }> = [];
      const skippedSensitiveFiles: string[] = [];
      let tokenEstimate = 0;
    const perFileChars = Math.max(1200, Math.floor((input.maxTokens * 4) / Math.min(input.maxFiles, input.files.length)));
      for (const file of unique(input.files).slice(0, input.maxFiles)) {
        const full = resolveInsideWorkspace(ctx.workspaceRoot, file);
        const risk = classifyPathRisk(file);
        if (risk.kind !== "normal") {
          redactedFiles.push({ path: file, reason: risk.reasons.join(", ") || risk.kind, riskTier: risk.tier });
          skippedSensitiveFiles.push(file);
          continue;
        }
        let content: string;
      try {
        const buf = await fs.readFile(full);
        if (buf.includes(0)) {
          skippedFiles.push(file);
          continue;
        }
        content = buf.toString("utf-8");
      } catch {
        skippedFiles.push(file);
        continue;
      }
      const clipped = content.slice(0, Math.min(perFileChars, DEFAULT_READ_MAX_BYTES));
      const truncated = clipped.length < content.length;
      const summary = input.includeSummaries ? summarizeFile(file, content) : "";
      const importantSections = input.includeImportantSections ? extractImportantSections(content) : undefined;
      const item = {
        path: file,
        summary,
        content: clipped,
        importantSections,
        truncated,
      };
      const itemTokens = estimateTokens(JSON.stringify(item));
      if (tokenEstimate + itemTokens > input.maxTokens && packed.length > 0) {
        skippedFiles.push(file);
        continue;
      }
      tokenEstimate += itemTokens;
      packed.push(item);
    }
      return {
        files: packed,
        combinedSummary: packed.map((f) => `- ${f.path}: ${f.summary}`).join("\n"),
        tokenEstimate,
        skippedFiles,
        redactedFiles,
        skippedSensitiveFiles,
      };
  },
};
