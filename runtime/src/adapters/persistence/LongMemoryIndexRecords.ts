import { z } from 'zod';
import { publicProjectionCanonicalIdSchema,longMemoryScopeSchema,longMemoryTypeSchema } from '@ariadne/protocol/public';

/** Derived worker metadata, never another memory-content authority. */
export const memoryIndexMetadataSchema=z.object({
  memoryId:publicProjectionCanonicalIdSchema,version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope:longMemoryScopeSchema,scopeId:publicProjectionCanonicalIdSchema,
  workspaceId:publicProjectionCanonicalIdSchema,sessionId:publicProjectionCanonicalIdSchema,
  status:z.enum(['candidate','active','inactive','deleted']),reviewedAt:z.string().datetime({offset:true}).nullable(),
  updatedAt:z.string().datetime({offset:true}),retentionUntil:z.string().datetime({offset:true}).nullable(),
  memoryType:longMemoryTypeSchema.nullable(),
  importance:z.number().min(0).max(1).nullable(),confidence:z.number().min(0).max(1).nullable()
}).strict().superRefine((row,context)=>{
  const owner=row.scope==='global'?'global':row.scope==='workspace'?row.workspaceId:row.sessionId;
  const deleted=row.status==='deleted';
  if(row.scopeId!==owner||(deleted?(row.memoryType!==null||row.importance!==null||row.confidence!==null||row.reviewedAt!==null||row.retentionUntil!==null)
    :(row.memoryType===null||row.importance===null||row.confidence===null||(row.status==='active'&&row.reviewedAt===null)||(row.status==='candidate'&&row.reviewedAt!==null))))
    context.addIssue({code:'custom',message:'Memory index metadata must bind to its authoritative owner and state.'});
});
export type MemoryIndexMetadata=z.infer<typeof memoryIndexMetadataSchema>;
export interface MemoryIndexCursor { readonly sequence:number;readonly commandId:string|null; }
export interface MemoryIndexChange {
  readonly sequence:number;readonly commandId:string;readonly memoryId:string;readonly version:number;
}
export interface MemoryIndexChangePage {
  readonly resetRequired:boolean;readonly head:MemoryIndexCursor;readonly changes:readonly MemoryIndexChange[];
}
