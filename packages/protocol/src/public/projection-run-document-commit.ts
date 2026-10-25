import { z } from 'zod';
import { assertPublicProjectionPayloadSafe, canonicalPublicProjectionJson, MAX_PUBLIC_PROJECTION_COMMIT_BYTES,
  publicProjectionCanonicalIdSchema, publicProjectionCanonicalTimestampSchema, publicProjectionChangeSchema } from './projection.js';
import { publicRunDocumentHeaderSchema } from './projection-run-document.js';

/** Independent stored Commit representation; released Commit 5.0 is unchanged. */
export const RUN_DOCUMENT_COMMIT_VERSION = '6.0' as const;
export const publicRunDocumentChangeSchema = z.object({ feature: z.literal('runs'), operation: z.literal('upsert'),
  aggregateId: publicProjectionCanonicalIdSchema, aggregateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  projectedAt: publicProjectionCanonicalTimestampSchema, dto: publicRunDocumentHeaderSchema
}).strict().superRefine((change, context) => {
  if (change.aggregateId !== change.dto.summary.runId || change.aggregateVersion !== change.dto.summary.version
    || change.projectedAt !== change.dto.summary.updatedAt) context.addIssue({ code: 'custom', message: 'Document change identity mismatch.' });
});
export type PublicRunDocumentChange = z.infer<typeof publicRunDocumentChangeSchema>;
export function isRunDocumentChange(value: unknown): value is PublicRunDocumentChange {
  return value !== null && typeof value === 'object' && 'feature' in value && value.feature === 'runs'
    && 'dto' in value && value.dto !== null && typeof value.dto === 'object' && 'documentContractVersion' in value.dto;
}
export const publicRunDocumentCommitSchema = z.object({ contractVersion: z.literal(RUN_DOCUMENT_COMMIT_VERSION),
  eventId: publicProjectionCanonicalIdSchema, sourceId: publicProjectionCanonicalIdSchema,
  sourceCursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), occurredAt: publicProjectionCanonicalTimestampSchema,
  changes: z.array(z.union([publicRunDocumentChangeSchema, publicProjectionChangeSchema])).min(1).max(256)
}).strict().superRefine((commit, context) => {
  const first = commit.changes[0];
  if (!isRunDocumentChange(first) || first.aggregateVersion !== commit.sourceCursor || first.projectedAt !== commit.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Document Commit requires its Run version as the source boundary.' }); return;
  }
  const identities = new Set<string>();
  commit.changes.forEach((change, index) => {
    const identity = `${change.feature}:${change.aggregateId}`;
    if (identities.has(identity) || (index > 0 && (change.feature !== 'decisions'
      || (change.dto !== null && (change.dto.runId !== first.aggregateId || change.dto.sessionId !== first.dto.summary.sessionId))))) {
      context.addIssue({ code: 'custom', message: 'Document Commit contains a duplicate or foreign change.' });
    }
    identities.add(identity);
  });
});
export type PublicRunDocumentCommit = z.infer<typeof publicRunDocumentCommitSchema>;
export function assertPublicRunDocumentCommit(value: unknown): PublicRunDocumentCommit {
  const commit = publicRunDocumentCommitSchema.parse(value); assertPublicProjectionPayloadSafe(commit);
  if (new TextEncoder().encode(canonicalPublicProjectionJson(commit)).length > MAX_PUBLIC_PROJECTION_COMMIT_BYTES) {
    throw new Error('run_document_commit_byte_limit_exceeded');
  }
  return commit;
}
