export interface LocateBudget {
  maxLocateSteps: number;
  maxSearchCalls: number;
  maxListCalls: number;
  maxReadForLocationCalls: number;
  maxCandidateFiles: number;
  maxPrimaryFiles: number;
}

export interface SearchPlan {
  goal: string;
  keywords: string[];
  possibleSymbols: string[];
  possiblePaths: string[];
  exclude: string[];
  taskType: "architecture_or_code_edit" | "debug" | "review" | "documentation" | "unknown";
}

export interface ProjectFileMeta {
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
  mtimeMs?: number;
}

export interface LocatedFile {
  path: string;
  score: number;
  reason: string;
  matchTypes: Array<"path" | "symbol" | "keyword" | "memory" | "recent" | "importance">;
}

export const DEFAULT_LOCATE_BUDGET: LocateBudget = {
  maxLocateSteps: 6,
  maxSearchCalls: 4,
  maxListCalls: 2,
  maxReadForLocationCalls: 2,
  maxCandidateFiles: 20,
  maxPrimaryFiles: 8,
};
