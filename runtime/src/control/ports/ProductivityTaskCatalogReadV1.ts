import type { TaskReference, TaskSourceMetadata, taskRelationSchema } from '@ariadne/protocol/public';
import type { z } from 'zod';

export type ProductivityTaskReference = TaskReference & { readonly source: 'goal' | 'workflow' | 'schedule' | 'occurrence' };
/** null Workspace list is the Runtime's explicit unrestricted authority scope. */
export interface ProductivityTaskReadScope {
  readonly workspaceIds: readonly string[] | null;
  readonly session: { readonly workspaceId: string; readonly sessionId: string } | null;
}
export interface ProductivityTaskCatalogPageV1 {
  readonly rows: readonly TaskSourceMetadata[];
  readonly next: ProductivityTaskReference | null;
  readonly observedAt: string;
  readonly eventCursor: number;
}
/** Read extension of the existing Productivity owner; no task state or mutation. */
export interface ProductivityTaskCatalogReadV1 {
  readTaskCatalogPage(scope: ProductivityTaskReadScope, after: ProductivityTaskReference | null,
    limit: number): Promise<ProductivityTaskCatalogPageV1>;
  readTaskCatalogItem(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference): Promise<TaskSourceMetadata | null>;
  readTaskRelations(scope: ProductivityTaskReadScope, reference: ProductivityTaskReference,
    expected: Pick<TaskSourceMetadata, 'version' | 'attempts'>, afterIndex: number, limit: number): Promise<
      { readonly status: 'missing' } | { readonly status: 'stale'; readonly currentVersion: number | null; readonly currentAttempts: number | null } |
      { readonly status: 'ok'; readonly rows: readonly z.infer<typeof taskRelationSchema>[];
        readonly total: number; readonly nextIndex: number | null }>;
}
