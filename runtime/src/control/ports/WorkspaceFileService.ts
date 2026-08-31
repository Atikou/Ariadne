declare const workspaceFileVersionBrand: unique symbol;

/** Opaque local-file freshness token. Consumers must compare it, never parse it. */
export type WorkspaceFileVersion = string & {
  readonly [workspaceFileVersionBrand]: true;
};

export interface WorkspaceTextFileReadOutcome {
  readonly content: string;
  readonly byteLength: number;
  readonly version: WorkspaceFileVersion;
}

export type WorkspaceTextFileWriteIntent =
  | { readonly kind: 'create_if_absent' }
  | {
      readonly kind: 'replace_if_version';
      readonly version: WorkspaceFileVersion;
    };

export interface WorkspaceTextFileWriteOutcome {
  readonly operation: 'created' | 'replaced';
  readonly byteLength: number;
  readonly version: WorkspaceFileVersion;
  readonly previousContent: string | null;
  readonly content: string;
}

/** One-based line and Unicode-code-point column in a stable observed file. */
export interface WorkspaceTextPosition {
  readonly line: number;
  readonly column: number;
}

/** Half-open text replacement range. Empty ranges insert text. */
export interface WorkspaceTextEdit {
  readonly start: WorkspaceTextPosition;
  readonly end: WorkspaceTextPosition;
  readonly text: string;
}

export interface WorkspaceTextFileEditOutcome {
  readonly operation: 'edited';
  readonly byteLength: number;
  readonly version: WorkspaceFileVersion;
  readonly appliedEdits: number;
  readonly previousContent: string;
  readonly content: string;
}

export interface WorkspaceTextFileMoveOutcome {
  readonly operation: 'moved';
  readonly byteLength: number;
  readonly version: WorkspaceFileVersion;
}

export interface WorkspaceTextFileDeleteOutcome {
  readonly operation: 'deleted';
  readonly byteLength: number;
}

/** Owns freshness checks and atomic publication for complete UTF-8 files. */
export interface WorkspaceFileService {
  readText(input: {
    readonly absolutePath: string;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileReadOutcome>;

  writeText(input: {
    readonly absolutePath: string;
    readonly content: string;
    readonly expected: WorkspaceTextFileWriteIntent;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileWriteOutcome>;

  editText(input: {
    readonly absolutePath: string;
    readonly edits: readonly WorkspaceTextEdit[];
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileEditOutcome>;

  moveText(input: {
    readonly sourceAbsolutePath: string;
    readonly destinationAbsolutePath: string;
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileMoveOutcome>;

  deleteText(input: {
    readonly absolutePath: string;
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileDeleteOutcome>;
}
