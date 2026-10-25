import { z } from 'zod';
import { PUBLIC_PROJECTION_CONTRACT_VERSION, publicProjectionCanonicalIdSchema } from './projection.js';

export const longMemoryScopeSchema = z.enum(['global', 'workspace', 'session']);
export const longMemoryTypeSchema = z.enum(['preference', 'habit', 'decision', 'fact', 'lesson', 'project_note',
  'recent_state', 'task_state', 'known_issue', 'tech_stack']);
export const longMemoryStatusSchema = z.enum(['candidate', 'active', 'inactive']);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime({ offset: true });
const scope = { contractVersion: z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),
  workspaceId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema };
export const longMemoryContentSchema = z.object({
  scope: longMemoryScopeSchema, memoryType: longMemoryTypeSchema,
  title: z.string().trim().min(1).max(256), content: z.string().trim().min(1).max(8_000),
  importance: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['public', 'workspace', 'sensitive']), retentionUntil: date.nullable()
}).strict();
export const longMemoryProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('agent'), runId: publicProjectionCanonicalIdSchema }).strict(),
  z.object({ kind: z.literal('import'), legacyMemoryId: publicProjectionCanonicalIdSchema }).strict()
]);
export const longMemoryRecordSchema = longMemoryContentSchema.extend({
  memoryId: publicProjectionCanonicalIdSchema, version, status: longMemoryStatusSchema,
  scopeId: publicProjectionCanonicalIdSchema, provenance: longMemoryProvenanceSchema,
  reviewedAt: date.nullable(), createdAt: date, updatedAt: date, expired: z.boolean()
}).strict();
const cursor = z.object({ updatedAt: date, memoryId: publicProjectionCanonicalIdSchema }).strict();
export const longMemoryCommandSchemas = [
  z.object({ kind: z.literal('memory.query'), ...scope, scope: longMemoryScopeSchema.nullable(),
    status: z.enum(['all', 'candidate', 'active', 'inactive']), before: cursor.nullable(), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('memory.read'), ...scope, memoryId: publicProjectionCanonicalIdSchema }).strict(),
  longMemoryContentSchema.extend({ kind: z.literal('memory.put'), ...scope,
    memoryId: publicProjectionCanonicalIdSchema, expectedVersion: version.nullable() }).strict(),
  z.object({ kind: z.literal('memory.transition'), ...scope, memoryId: publicProjectionCanonicalIdSchema,
    expectedVersion: version, action: z.enum(['activate', 'deactivate', 'reject']) }).strict(),
  z.object({ kind: z.literal('memory.delete'), ...scope, memoryId: publicProjectionCanonicalIdSchema, expectedVersion: version }).strict(),
  z.object({ kind: z.literal('memory.recall'), ...scope, query: z.string().trim().min(1).max(4_000),
    limit: z.number().int().min(1).max(20) }).strict()
] as const;
export const memoryEmbeddingStatusSchema = z.object({
  provider: z.enum(['lexical', 'local-gguf']), capability: z.enum(['lexical_approximation', 'semantic']),
  dimension: z.number().int().positive().max(65_536), modelId: z.string().min(1).max(256).nullable(),
  degraded: z.boolean(), reason: z.enum(['lexical_approximation_not_semantic', 'model_unavailable', 'index_rebuild_required']).nullable()
}).strict();
export const longMemoryResultSchemas = [
  z.object({ kind: z.literal('memory.query_result'), memories: z.array(longMemoryRecordSchema).max(100), nextCursor: cursor.nullable() }).strict(),
  z.object({ kind: z.literal('memory.read_result'), memory: longMemoryRecordSchema.nullable() }).strict(),
  z.object({ kind: z.literal('memory.updated'), memoryId: publicProjectionCanonicalIdSchema, version }).strict(),
  z.object({ kind: z.literal('memory.deleted'), memoryId: publicProjectionCanonicalIdSchema, version }).strict(),
  z.object({ kind: z.literal('memory.recall_result'), hits: z.array(z.object({ memory: longMemoryRecordSchema,
    score: z.number().min(0).max(1), reason: z.enum(['fixed_preference', 'lexical', 'semantic', 'hybrid']) }).strict()).max(20),
    embedding: memoryEmbeddingStatusSchema, complete: z.boolean() }).strict()
] as const;
export type LongMemoryCommand = z.infer<typeof longMemoryCommandSchemas[number]>;
export type LongMemoryResult = z.infer<typeof longMemoryResultSchemas[number]>;
export type LongMemoryRecord = z.infer<typeof longMemoryRecordSchema>;
export type LongMemoryContent = z.infer<typeof longMemoryContentSchema>;
export type LongMemoryProvenance = z.infer<typeof longMemoryProvenanceSchema>;
export type MemoryEmbeddingStatus = z.infer<typeof memoryEmbeddingStatusSchema>;
