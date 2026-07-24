export interface ProjectFileRecord {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  mtimeMs: number;
  contentHash: string;
  language: string;
  tags: string[];
  summary?: string;
}

export interface ProjectSymbolRecord {
  filePath: string;
  symbol: string;
  kind: string;
  line: number;
}

export type SymbolSearchMatchMode = "exact" | "prefix" | "contains";

export interface SymbolSearchQueryInput {
  projectId: string;
  workspaceRoot: string;
  queries: string[];
  match?: SymbolSearchMatchMode;
  kinds?: string[];
  pathPrefix?: string;
  limit?: number;
}

export interface ProjectIndexStats {
  projectId: string;
  workspaceRoot: string;
  fileCount: number;
  symbolCount: number;
  lastIndexedAt?: string;
}

export interface ProjectIndexSyncResult {
  upserted: number;
  removed: number;
  symbolsUpdated: number;
  skipped: number;
  dependenciesUpdated?: number;
  exportsUpdated?: number;
  semanticIndexed?: number;
}

export interface ProjectImportRecord {
  fromPath: string;
  importSpec: string;
  resolvedPath?: string;
  kind: string;
  line: number;
}

export interface ProjectExportRecord {
  filePath: string;
  exportName: string;
  kind: string;
  line: number;
}

export interface GraphNeighborRecord {
  path: string;
  relation: "imports" | "imported_by";
  depth: number;
}
