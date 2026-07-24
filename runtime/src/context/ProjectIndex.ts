import path from "node:path";

import type { DatabaseManager } from "./DatabaseManager.js";
import {
  attachResolvedImportPaths,
} from "./importExportParser.js";
import type { ProjectSemanticIndexer } from "./ProjectSemanticIndexer.js";
import {
  defaultCodeIntelligenceService,
  type CodeIntelligenceService,
} from "./CodeIntelligenceService.js";
import type {
  GraphNeighborRecord,
  ProjectDiagnosticRecord,
  ProjectFileRecord,
  ProjectIndexStats,
  ProjectIndexSyncResult,
  ProjectReferenceRecord,
  ProjectSymbolRecord,
  RepoMapNode,
  SymbolSearchQueryInput,
} from "./projectIndexTypes.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".py", ".cs",
]);

export class ProjectIndex {
  constructor(
    private readonly db: DatabaseManager,
    private readonly codeIntelligence: CodeIntelligenceService = defaultCodeIntelligenceService,
  ) {}

  dispose(): Promise<void> {
    return this.codeIntelligence.dispose();
  }

  getStats(projectId: string, workspaceRoot: string): ProjectIndexStats {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const fileRow = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed_at
         FROM project_files WHERE project_id=? AND workspace_root=?`,
      )
      .get(projectId, normalizedRoot) as { count: number; last_indexed_at?: string };
    const symbolRow = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM project_symbols WHERE project_id=? AND workspace_root=?`,
      )
      .get(projectId, normalizedRoot) as { count: number };
    return {
      projectId,
      workspaceRoot: normalizedRoot,
      fileCount: fileRow.count,
      symbolCount: symbolRow.count,
      lastIndexedAt: fileRow.last_indexed_at,
    };
  }

  hasUsableIndex(projectId: string, workspaceRoot: string, minFiles = 8): boolean {
    return this.getStats(projectId, workspaceRoot).fileCount >= minFiles;
  }

  listFiles(projectId: string, workspaceRoot: string): ProjectFileRecord[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const rows = this.db.connection
      .prepare(
        `SELECT path, file_name, extension, size_bytes, modified_at, mtime_ms, content_hash,
                language, tags_json, summary
         FROM project_files
         WHERE project_id=? AND workspace_root=?
         ORDER BY path`,
      )
      .all(projectId, normalizedRoot) as Array<{
      path: string;
      file_name: string;
      extension: string;
      size_bytes: number;
      modified_at: string;
      mtime_ms: number;
      content_hash: string;
      language: string;
      tags_json: string;
      summary: string | null;
    }>;
    return rows.map((row) => ({
      path: row.path,
      fileName: row.file_name,
      extension: row.extension,
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
      language: row.language,
      tags: parseTags(row.tags_json),
      summary: row.summary ?? undefined,
    }));
  }

  searchSymbols(
    projectId: string,
    workspaceRoot: string,
    names: string[],
  ): ProjectSymbolRecord[] {
    return this.searchSymbolsQuery({
      projectId,
      workspaceRoot,
      queries: names,
      match: "exact",
    });
  }

  searchSymbolsQuery(input: SymbolSearchQueryInput): ProjectSymbolRecord[] {
    const normalizedRoot = normalizeRoot(input.workspaceRoot);
    const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))];
    if (!queries.length) return [];

    const match = input.match ?? "exact";
    const limit = Math.max(1, input.limit ?? 50);
    const kinds = input.kinds?.map((k) => k.toLowerCase());
    const pathPrefix = input.pathPrefix?.replace(/\\/g, "/");
    const hits: ProjectSymbolRecord[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      const lower = query.toLowerCase();
      let sql = `SELECT file_path, symbol, kind, line
                 FROM project_symbols
                 WHERE project_id=? AND workspace_root=?`;
      const params: Array<string | number> = [input.projectId, normalizedRoot];

      if (match === "exact") {
        sql += " AND lower(symbol)=?";
        params.push(lower);
      } else if (match === "prefix") {
        sql += " AND lower(symbol) LIKE ?";
        params.push(`${lower}%`);
      } else {
        sql += " AND lower(symbol) LIKE ?";
        params.push(`%${lower}%`);
      }

      if (pathPrefix) {
        sql += " AND file_path LIKE ?";
        params.push(`${pathPrefix}%`);
      }
      if (kinds?.length) {
        sql += ` AND lower(kind) IN (${kinds.map(() => "?").join(",")})`;
        params.push(...kinds);
      }

      sql += " ORDER BY symbol, file_path LIMIT ?";
      params.push(limit);

      const rows = this.db.connection.prepare(sql).all(...params) as Array<{
        file_path: string;
        symbol: string;
        kind: string;
        line: number;
      }>;

      for (const row of rows) {
        const key = `${row.file_path}:${row.symbol}:${row.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          filePath: row.file_path,
          symbol: row.symbol,
          kind: row.kind,
          line: row.line,
        });
        if (hits.length >= limit) return hits;
      }
    }

    return hits.slice(0, limit);
  }

  getDependencies(projectId: string, workspaceRoot: string, filePath: string): string[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const rows = this.db.connection
      .prepare(
        `SELECT DISTINCT resolved_path AS path
         FROM project_imports
         WHERE project_id=? AND workspace_root=? AND from_path=? AND resolved_path IS NOT NULL
         ORDER BY resolved_path`,
      )
      .all(projectId, normalizedRoot, filePath) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  getDependents(projectId: string, workspaceRoot: string, filePath: string): string[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const rows = this.db.connection
      .prepare(
        `SELECT DISTINCT from_path AS path
         FROM project_imports
         WHERE project_id=? AND workspace_root=? AND resolved_path=?
         ORDER BY from_path`,
      )
      .all(projectId, normalizedRoot, filePath) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  expandGraphNeighbors(
    projectId: string,
    workspaceRoot: string,
    seeds: string[],
    options?: { maxDepth?: number; limit?: number },
  ): GraphNeighborRecord[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const maxDepth = Math.max(1, options?.maxDepth ?? 1);
    const limit = Math.max(1, options?.limit ?? 24);
    const seen = new Set<string>(seeds);
    const out: GraphNeighborRecord[] = [];
    let frontier = [...new Set(seeds)];

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next: string[] = [];
      for (const seed of frontier) {
        for (const dep of this.getDependencies(projectId, normalizedRoot, seed)) {
          if (seen.has(dep)) continue;
          seen.add(dep);
          out.push({ path: dep, relation: "imports", depth });
          next.push(dep);
          if (out.length >= limit) return out;
        }
        for (const dependent of this.getDependents(projectId, normalizedRoot, seed)) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          out.push({ path: dependent, relation: "imported_by", depth });
          next.push(dependent);
          if (out.length >= limit) return out;
        }
      }
      frontier = next;
    }
    return out;
  }

  getRelevantRepoMap(
    projectId: string,
    workspaceRoot: string,
    query: string,
    options?: { limit?: number; maxDepth?: number },
  ): RepoMapNode[] {
    const normalizedRoot = normalizeRoot(workspaceRoot);
    const limit = Math.max(1, Math.min(options?.limit ?? 12, 50));
    const tokens = tokenizeQuery(query).slice(0, 12);
    const scores = new Map<string, { score: number; reasons: Set<string> }>();
    const add = (filePath: string, score: number, reason: string): void => {
      const current = scores.get(filePath) ?? { score: 0, reasons: new Set<string>() };
      current.score += score;
      current.reasons.add(reason);
      scores.set(filePath, current);
    };

    for (const token of tokens) {
      const like = `%${token.toLowerCase()}%`;
      const fileRows = this.db.connection.prepare(
        `SELECT path
         FROM project_files
         WHERE project_id=? AND workspace_root=?
           AND (lower(path) LIKE ? OR lower(file_name) LIKE ? OR lower(COALESCE(summary, '')) LIKE ?)
         ORDER BY path LIMIT ?`,
      ).all(projectId, normalizedRoot, like, like, like, limit * 4) as Array<{ path: string }>;
      for (const row of fileRows) add(row.path, 6, `file:${token}`);

      const symbolRows = this.db.connection.prepare(
        `SELECT DISTINCT file_path
         FROM project_symbols
         WHERE project_id=? AND workspace_root=? AND lower(symbol) LIKE ?
         ORDER BY file_path LIMIT ?`,
      ).all(projectId, normalizedRoot, like, limit * 4) as Array<{ file_path: string }>;
      for (const row of symbolRows) add(row.file_path, 10, `symbol:${token}`);

      const referenceRows = this.db.connection.prepare(
        `SELECT DISTINCT file_path
         FROM project_references
         WHERE project_id=? AND workspace_root=? AND lower(symbol) LIKE ?
         ORDER BY file_path LIMIT ?`,
      ).all(projectId, normalizedRoot, like, limit * 4) as Array<{ file_path: string }>;
      for (const row of referenceRows) add(row.file_path, 4, `reference:${token}`);
    }

    if (scores.size === 0) {
      const recent = this.db.connection.prepare(
        `SELECT path
         FROM project_files
         WHERE project_id=? AND workspace_root=?
         ORDER BY indexed_at DESC, path
         LIMIT ?`,
      ).all(projectId, normalizedRoot, Math.min(limit, 4)) as Array<{ path: string }>;
      for (const row of recent) add(row.path, 1, "recent");
    }

    const rankedSeeds = [...scores.entries()]
      .sort(([pathA, a], [pathB, b]) => b.score - a.score || pathA.localeCompare(pathB))
      .slice(0, Math.max(1, Math.ceil(limit / 2)))
      .map(([filePath]) => filePath);
    for (const neighbor of this.expandGraphNeighbors(
      projectId,
      normalizedRoot,
      rankedSeeds,
      { maxDepth: options?.maxDepth ?? 1, limit },
    )) {
      add(neighbor.path, Math.max(1, 3 - neighbor.depth), `${neighbor.relation}:${neighbor.depth}`);
    }

    return [...scores.entries()]
      .sort(([pathA, a], [pathB, b]) => b.score - a.score || pathA.localeCompare(pathB))
      .slice(0, limit)
      .map(([filePath, rank]) =>
        this.buildRepoMapNode(projectId, normalizedRoot, filePath, rank.score, [...rank.reasons]),
      )
      .filter((node): node is RepoMapNode => node !== undefined);
  }

  async syncFiles(input: {
    projectId: string;
    workspaceRoot: string;
    files: ProjectFileRecord[];
    extractSymbols?: boolean;
    extractDependencies?: boolean;
    summaries?: Map<string, string>;
    semanticIndexer?: ProjectSemanticIndexer;
    /** 为 true 时即使 content_hash 未变也重算符号/依赖/语义索引。 */
    forceResync?: boolean;
    /** 为 true 时删除本次 files 未包含的既有索引条目（全量 project_scan）；增量更新应传 false。 */
    pruneMissing?: boolean;
  }): Promise<ProjectIndexSyncResult> {
    const normalizedRoot = normalizeRoot(input.workspaceRoot);
    const indexedAt = new Date().toISOString();
    const extractSymbols = input.extractSymbols ?? true;
    const extractDependencies = input.extractDependencies ?? true;
    const forceResync = input.forceResync ?? false;
    const pruneMissing = input.pruneMissing ?? false;
    const incomingPaths = new Set(input.files.map((f) => f.path));

    const existingRows = this.db.connection
      .prepare(
        `SELECT path, content_hash FROM project_files WHERE project_id=? AND workspace_root=?`,
      )
      .all(input.projectId, normalizedRoot) as Array<{ path: string; content_hash: string }>;
    const knownFiles = new Set(input.files.map((f) => f.path));
    for (const row of existingRows) knownFiles.add(row.path);
    const existingHashes = new Map(existingRows.map((row) => [row.path, row.content_hash]));

    const upsertFile = this.db.connection.prepare(
      `INSERT INTO project_files
       (project_id, workspace_root, path, file_name, extension, size_bytes, modified_at, mtime_ms,
        content_hash, language, tags_json, summary, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, path) DO UPDATE SET
         file_name=excluded.file_name,
         extension=excluded.extension,
         size_bytes=excluded.size_bytes,
         modified_at=excluded.modified_at,
         mtime_ms=excluded.mtime_ms,
         content_hash=excluded.content_hash,
         language=excluded.language,
         tags_json=excluded.tags_json,
         summary=excluded.summary,
         indexed_at=excluded.indexed_at`,
    );
    const deleteSymbols = this.db.connection.prepare(
      `DELETE FROM project_symbols WHERE project_id=? AND workspace_root=? AND file_path=?`,
    );
    const deleteImports = this.db.connection.prepare(
      `DELETE FROM project_imports WHERE project_id=? AND workspace_root=? AND from_path=?`,
    );
    const deleteExports = this.db.connection.prepare(
      `DELETE FROM project_exports WHERE project_id=? AND workspace_root=? AND file_path=?`,
    );
    const deleteReferences = this.db.connection.prepare(
      `DELETE FROM project_references WHERE project_id=? AND workspace_root=? AND file_path=?`,
    );
    const deleteDiagnostics = this.db.connection.prepare(
      `DELETE FROM project_diagnostics WHERE project_id=? AND workspace_root=? AND file_path=?`,
    );
    const insertSymbol = this.db.connection.prepare(
      `INSERT INTO project_symbols
       (project_id, workspace_root, file_path, symbol, kind, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, file_path, symbol) DO UPDATE SET
         kind=excluded.kind,
         line=excluded.line,
         indexed_at=excluded.indexed_at`,
    );
    const insertImport = this.db.connection.prepare(
      `INSERT INTO project_imports
       (project_id, workspace_root, from_path, import_spec, resolved_path, kind, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertExport = this.db.connection.prepare(
      `INSERT INTO project_exports
       (project_id, workspace_root, file_path, export_name, kind, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, file_path, export_name) DO UPDATE SET
         kind=excluded.kind,
         line=excluded.line,
         indexed_at=excluded.indexed_at`,
    );
    const insertReference = this.db.connection.prepare(
      `INSERT INTO project_references
       (project_id, workspace_root, file_path, symbol, kind, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, file_path, symbol, kind, line) DO UPDATE SET
         indexed_at=excluded.indexed_at`,
    );
    const insertDiagnostic = this.db.connection.prepare(
      `INSERT INTO project_diagnostics
       (project_id, workspace_root, file_path, message, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_root, file_path, message, line) DO UPDATE SET
         indexed_at=excluded.indexed_at`,
    );

    let upserted = 0;
    let skipped = 0;
    let symbolsUpdated = 0;
    let dependenciesUpdated = 0;
    let exportsUpdated = 0;
    let semanticIndexed = 0;
    let referencesUpdated = 0;
    let diagnosticsUpdated = 0;

    for (const file of input.files) {
      const priorHash = existingHashes.get(file.path);
      const hashChanged = priorHash !== file.contentHash;
      const shouldResync = hashChanged || forceResync;
      if (!shouldResync && priorHash) {
        skipped += 1;
        continue;
      }

      const shouldAnalyze = CODE_EXTENSIONS.has(file.extension) && (extractSymbols || extractDependencies);
      const analysis = shouldAnalyze
        ? await this.codeIntelligence.analyzeFile(normalizedRoot, file.path)
        : undefined;
      const symbols = extractSymbols ? analysis?.symbols ?? [] : [];
      const imports = extractDependencies
        ? attachResolvedImportPaths(analysis?.imports ?? [], knownFiles)
        : [];
      const exports = extractDependencies ? analysis?.exports ?? [] : [];
      const references: ProjectReferenceRecord[] = analysis?.references ?? [];
      const diagnostics = (analysis?.parseDiagnostics ?? []).map(
        (message) => parseDiagnostic(file.path, message),
      );

      this.db.connection.exec("BEGIN IMMEDIATE");
      try {
        upsertFile.run(
          input.projectId,
          normalizedRoot,
          file.path,
          file.fileName,
          file.extension,
          file.sizeBytes,
          file.modifiedAt,
          file.mtimeMs,
          file.contentHash,
          file.language,
          JSON.stringify(file.tags),
          input.summaries?.get(file.path) ?? file.summary ?? null,
          indexedAt,
        );
        deleteSymbols.run(input.projectId, normalizedRoot, file.path);
        deleteImports.run(input.projectId, normalizedRoot, file.path);
        deleteExports.run(input.projectId, normalizedRoot, file.path);
        deleteReferences.run(input.projectId, normalizedRoot, file.path);
        deleteDiagnostics.run(input.projectId, normalizedRoot, file.path);

        for (const symbol of symbols) {
          insertSymbol.run(
            input.projectId, normalizedRoot, file.path,
            symbol.symbol, symbol.kind, symbol.line, indexedAt,
          );
        }
        for (const edge of imports) {
          insertImport.run(
            input.projectId, normalizedRoot, edge.fromPath, edge.importSpec,
            edge.resolvedPath ?? null, edge.kind, edge.line, indexedAt,
          );
        }
        for (const edge of exports) {
          insertExport.run(
            input.projectId, normalizedRoot, edge.filePath,
            edge.exportName, edge.kind, edge.line, indexedAt,
          );
        }
        for (const reference of references) {
          insertReference.run(
            input.projectId, normalizedRoot, file.path,
            reference.symbol, reference.kind, reference.line, indexedAt,
          );
        }
        for (const diagnostic of diagnostics) {
          insertDiagnostic.run(
            input.projectId, normalizedRoot, file.path,
            diagnostic.message, diagnostic.line ?? 0, indexedAt,
          );
        }
        this.db.connection.exec("COMMIT");
      } catch (error) {
        this.db.connection.exec("ROLLBACK");
        throw error;
      }

      upserted += 1;
      symbolsUpdated += symbols.length;
      dependenciesUpdated += imports.length;
      exportsUpdated += exports.length;
      referencesUpdated += references.length;
      diagnosticsUpdated += diagnostics.length;

      if (input.semanticIndexer) {
        try {
          await input.semanticIndexer.indexFile({
            projectId: input.projectId,
            workspaceRoot: normalizedRoot,
            path: file.path,
            summary: input.summaries?.get(file.path) ?? file.summary,
            symbols: symbols.map((s) => s.symbol),
            tags: file.tags,
          });
          semanticIndexed += 1;
        } catch {
          // LanceDB 故障不阻断索引写入。
        }
      }
    }

    let removed = 0;
    if (pruneMissing) {
      for (const row of existingRows) {
        if (incomingPaths.has(row.path)) continue;
        this.db.connection
          .prepare(`DELETE FROM project_files WHERE project_id=? AND workspace_root=? AND path=?`)
          .run(input.projectId, normalizedRoot, row.path);
        deleteSymbols.run(input.projectId, normalizedRoot, row.path);
        deleteImports.run(input.projectId, normalizedRoot, row.path);
        deleteExports.run(input.projectId, normalizedRoot, row.path);
        deleteReferences.run(input.projectId, normalizedRoot, row.path);
        deleteDiagnostics.run(input.projectId, normalizedRoot, row.path);
        if (input.semanticIndexer) {
          try {
            await input.semanticIndexer.removeFile(input.projectId, normalizedRoot, row.path);
          } catch {
            // ignore
          }
        }
        removed += 1;
      }
    }

    return {
      upserted,
      removed,
      symbolsUpdated,
      skipped,
      dependenciesUpdated,
      exportsUpdated,
      semanticIndexed,
      referencesUpdated,
      diagnosticsUpdated,
    };
  }

  private buildRepoMapNode(
    projectId: string,
    workspaceRoot: string,
    filePath: string,
    score: number,
    reasons: string[],
  ): RepoMapNode | undefined {
    const file = this.db.connection.prepare(
      `SELECT content_hash FROM project_files
       WHERE project_id=? AND workspace_root=? AND path=?`,
    ).get(projectId, workspaceRoot, filePath) as { content_hash: string } | undefined;
    if (!file) return undefined;

    const symbols = this.db.connection.prepare(
      `SELECT symbol FROM project_symbols
       WHERE project_id=? AND workspace_root=? AND file_path=?
       ORDER BY line, symbol LIMIT 50`,
    ).all(projectId, workspaceRoot, filePath) as Array<{ symbol: string }>;
    const diagnostics = this.db.connection.prepare(
      `SELECT message, line FROM project_diagnostics
       WHERE project_id=? AND workspace_root=? AND file_path=?
       ORDER BY line, message LIMIT 20`,
    ).all(projectId, workspaceRoot, filePath) as Array<{ message: string; line: number }>;

    return {
      path: filePath,
      score,
      reasons: reasons.sort(),
      symbols: symbols.map((row) => row.symbol),
      imports: this.getDependencies(projectId, workspaceRoot, filePath),
      importedBy: this.getDependents(projectId, workspaceRoot, filePath),
      diagnostics: diagnostics.map((row) => row.line > 0 ? `${row.line}:${row.message}` : row.message),
      contentHash: file.content_hash,
    };
  }
}

export function projectFileToScanMeta(file: ProjectFileRecord): {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  language: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  tags: string[];
  hash: string;
} {
  return {
    path: file.path,
    fileName: file.fileName,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    language: file.language,
    symbols: [],
    imports: [],
    exports: [],
    tags: file.tags,
    hash: file.contentHash,
  };
}

export async function extractSymbolsForFile(
  workspaceRoot: string,
  relPath: string,
  codeIntelligence: CodeIntelligenceService = defaultCodeIntelligenceService,
): Promise<ProjectSymbolRecord[]> {
  return (await codeIntelligence.analyzeFile(workspaceRoot, relPath)).symbols;
}

export async function extractSymbolsFromContent(
  filePath: string,
  content: string,
): Promise<ProjectSymbolRecord[]> {
  return (await defaultCodeIntelligenceService.analyzeContent(filePath, content)).symbols;
}

function normalizeRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).replace(/\\/g, "/");
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
      .filter((token) => token.length > 1),
  )];
}

function parseDiagnostic(filePath: string, diagnostic: string): ProjectDiagnosticRecord {
  const match = diagnostic.match(/^(\d+):(.*)$/s);
  return match
    ? { filePath, line: Number(match[1]), message: match[2]!.trim() }
    : { filePath, message: diagnostic };
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
