import type { WorkspaceFileVersion } from './WorkspaceFileService.js';

export interface WorkspaceSearchBounds {
  readonly maxResults: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface WorkspaceTextSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly version: WorkspaceFileVersion;
}

export interface WorkspaceTextSearchOutcome {
  readonly matches: readonly WorkspaceTextSearchMatch[];
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly skippedFiles: number;
  readonly truncated: boolean;
}

export interface WorkspaceGlobMatch {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export interface WorkspaceGlobOutcome {
  readonly matches: readonly WorkspaceGlobMatch[];
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

/** Read-only bounded discovery over one already-authorized Workspace root. */
export interface WorkspaceSearchService {
  searchText(input: {
    readonly workspaceRoot: string;
    readonly absoluteDirectory: string;
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly includeGlob: string;
    readonly excludeGlobs: readonly string[];
    readonly bounds: WorkspaceSearchBounds;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextSearchOutcome>;

  glob(input: {
    readonly workspaceRoot: string;
    readonly absoluteDirectory: string;
    readonly pattern: string;
    readonly excludeGlobs: readonly string[];
    readonly maxResults: number;
    readonly maxEntries: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceGlobOutcome>;
}
