import type { WorkspaceDocumentCommand,WorkspaceDocumentResult } from '@ariadne/protocol/public';

/** Explicit user document operations over the same file owner used by Agent Tools. */
export interface WorkspaceDocumentAuthority {
  execute(command:WorkspaceDocumentCommand,signal:AbortSignal):Promise<WorkspaceDocumentResult>;
}
