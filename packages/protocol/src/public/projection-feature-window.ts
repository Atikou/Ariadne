import { z } from 'zod';
import { canonicalPublicProjectionJson, publicProjectionCanonicalIdSchema, publicProjectionChangeSchema,
  publicProjectionDigestSchema, type PublicProjectionChange } from './projection.js';
import { publicProjectionViewManifestSchema } from './projection-views.js';
import { publicProjectionSnapshotPageResetSchema } from './projection-pages.js';
import { assertProjectionCatalogResult, catalogSha256 } from './projection-catalog.js';

export const publicProjectionFeatureWindowSchema = z.object({
  feature: z.enum(['models', 'diagnostics', 'inference_streams']),
  filter: z.enum(['all', 'streaming']), limit: z.number().int().min(1).max(128),
  beforeAggregateId: publicProjectionCanonicalIdSchema.optional(),
  runIds: z.array(publicProjectionCanonicalIdSchema).min(1).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.feature !== 'inference_streams' && (value.filter !== 'all' || value.runIds !== undefined)
    || (value.runIds !== undefined && new Set(value.runIds).size !== value.runIds.length)) {
    context.addIssue({ code: 'custom', message: 'Feature window filter or Run identity set is invalid.' });
  }
});
export type PublicProjectionFeatureWindow = z.infer<typeof publicProjectionFeatureWindowSchema>;
export const publicProjectionFeatureWindowRequestSchema = z.object({
  windowContractVersion: z.literal('1.0'), manifest: publicProjectionViewManifestSchema,
  window: publicProjectionFeatureWindowSchema
}).strict().superRefine((value, context) => {
  const session = value.manifest.scope.kind === 'session';
  if (!value.manifest.selectedFeatures.includes(value.window.feature)
    || (value.window.feature === 'inference_streams' ? !session : value.manifest.scope.kind !== 'directory')) {
    context.addIssue({ code: 'custom', message: 'Feature window escaped its manifest selection or scope.' });
  }
});
export type PublicProjectionFeatureWindowRequest = z.infer<typeof publicProjectionFeatureWindowRequestSchema>;
export function comparePublicProjectionFeatureWindowRows(left: PublicProjectionChange, right: PublicProjectionChange): number {
  return (left.projectedAt === right.projectedAt ? 0 : left.projectedAt > right.projectedAt ? -1 : 1)
    || (left.aggregateId === right.aggregateId ? 0 : left.aggregateId < right.aggregateId ? -1 : 1);
}
export const publicProjectionFeatureWindowOkSchema = z.object({
  status: z.literal('ok'), windowContractVersion: z.literal('1.0'), manifest: publicProjectionViewManifestSchema,
  window: publicProjectionFeatureWindowSchema, changes: z.array(publicProjectionChangeSchema).max(128),
  hasEarlier: z.boolean(), windowDigest: publicProjectionDigestSchema
}).strict().superRefine((value, context) => {
  const request = { windowContractVersion: value.windowContractVersion, manifest: value.manifest, window: value.window };
  if (!publicProjectionFeatureWindowRequestSchema.safeParse(request).success || value.changes.length > value.window.limit
    || (value.hasEarlier && value.changes.length === 0)
    || value.changes.some((change, index) => change.feature !== value.window.feature || change.dto === null
      || change.operation !== 'upsert' || (index > 0 && comparePublicProjectionFeatureWindowRows(value.changes[index - 1]!, change) >= 0)
      || (change.feature === 'inference_streams' && change.dto !== null
        && (value.manifest.scope.kind !== 'session' || change.dto.sessionId !== value.manifest.scope.sessionId
          || (value.window.filter === 'streaming' && change.dto.status !== 'streaming')
          || (value.window.runIds !== undefined && !value.window.runIds.includes(change.dto.runId)))))) {
    context.addIssue({ code: 'custom', message: 'Feature window contents escaped their owner, filter, order or limit.' });
  }
});
export const publicProjectionFeatureWindowResultSchema = z.union([publicProjectionFeatureWindowOkSchema,
  publicProjectionSnapshotPageResetSchema,
  z.object({ status: z.literal('anchor_unavailable'), snapshotId: publicProjectionCanonicalIdSchema }).strict()]);
export type PublicProjectionFeatureWindowResult = z.infer<typeof publicProjectionFeatureWindowResultSchema>;
export type PublicProjectionFeatureWindowOk = z.infer<typeof publicProjectionFeatureWindowOkSchema>;
export async function verifyPublicProjectionFeatureWindow(request: PublicProjectionFeatureWindowRequest, value: unknown): Promise<PublicProjectionFeatureWindowResult> {
  publicProjectionFeatureWindowRequestSchema.parse(request);
  const result = assertProjectionCatalogResult(publicProjectionFeatureWindowResultSchema, value);
  if (result.status === 'reset_required') return result;
  if (result.status === 'anchor_unavailable') {
    if (result.snapshotId !== request.manifest.snapshotId || request.window.beforeAggregateId === undefined) {
      throw new Error('projection_feature_window_anchor_request_mismatch');
    }
    return result;
  }
  if (canonicalPublicProjectionJson(result.manifest) !== canonicalPublicProjectionJson(request.manifest)
    || canonicalPublicProjectionJson(result.window) !== canonicalPublicProjectionJson(request.window)) {
    throw new Error('projection_feature_window_request_mismatch');
  }
  const { windowDigest, ...payload } = result;
  if (windowDigest !== await catalogSha256(canonicalPublicProjectionJson(payload))) throw new Error('projection_feature_window_digest_mismatch');
  return result;
}
