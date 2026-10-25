import { z } from 'zod';
import { PUBLIC_PROJECTION_CONTRACT_VERSION,publicProjectionCanonicalIdSchema } from './projection.js';

/** Text documents are requested explicitly and never copied into Public Projection. */
export const WORKSPACE_DOCUMENT_MAX_BYTES=262_144;
/** Public, body-free failures proving that the requested file mutation did not apply.
 * Their exact messages are safe to retain in command receipts; arbitrary I/O
 * failures are not covered by this contract and may have an unknown outcome. */
export const WORKSPACE_DOCUMENT_FAILURE_MESSAGES:Readonly<Record<string,string>>=Object.freeze({
  workspace_scope_unknown:'工作区未获授权。',workspace_is_read_only:'此工作区只允许读取文件。',
  workspace_file_stale_version:'文件已被其他操作更新，请重新读取后再保存。',workspace_file_already_exists:'目标文件已经存在，不能覆盖。',
  workspace_file_not_found:'文件不存在，请刷新文件列表。',workspace_file_not_text:'此文件不是可编辑的 UTF-8 文本。',
  workspace_file_too_large:'文本编辑器支持最多 256 KiB 的文件。',workspace_file_not_regular:'此条目不是普通文件。',
  workspace_symlink_rejected:'此写入路径包含符号链接，不能操作。',workspace_documents_unavailable:'文件编辑服务不可用。'
});
export const workspaceDocumentPathSchema=z.string().min(1).max(1_024).refine(path=>
  !/[\\:<>"|?*\u0000-\u001f]/u.test(path)&&path.split('/').every(segment=>segment!==''&&segment!=='.'&&segment!=='..'
    &&!/[. ]$/u.test(segment)&&!/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(segment)),
  'Use a contained, forward-slash workspace-relative file path.');
export const workspaceDocumentVersionSchema=z.string().regex(/^workspace-file-v1:[a-f0-9]{64}$/u);
const owner={contractVersion:z.literal(PUBLIC_PROJECTION_CONTRACT_VERSION),workspaceId:publicProjectionCanonicalIdSchema,path:workspaceDocumentPathSchema};
export const workspaceDocumentCommandSchemas=[
  z.object({...owner,kind:z.literal('workspace.document.read')}).strict(),
  z.object({...owner,kind:z.literal('workspace.document.save'),expectedVersion:workspaceDocumentVersionSchema.nullable(),content:z.string().max(WORKSPACE_DOCUMENT_MAX_BYTES)}).strict(),
  z.object({...owner,kind:z.literal('workspace.document.move'),expectedVersion:workspaceDocumentVersionSchema,destination:workspaceDocumentPathSchema}).strict(),
  z.object({...owner,kind:z.literal('workspace.document.delete'),expectedVersion:workspaceDocumentVersionSchema}).strict()
] as const;
export const workspaceDocumentCommandSchema=z.discriminatedUnion('kind',workspaceDocumentCommandSchemas);
export type WorkspaceDocumentCommand=z.infer<typeof workspaceDocumentCommandSchema>;
const metadata={workspaceId:publicProjectionCanonicalIdSchema,path:workspaceDocumentPathSchema,byteLength:z.number().int().min(0).max(WORKSPACE_DOCUMENT_MAX_BYTES)};
export const workspaceDocumentResultSchemas=[
  z.object({...metadata,kind:z.literal('workspace.document.read_result'),content:z.string().max(WORKSPACE_DOCUMENT_MAX_BYTES),version:workspaceDocumentVersionSchema,writable:z.boolean()}).strict(),
  z.object({...metadata,kind:z.literal('workspace.document.saved'),operation:z.enum(['created','replaced']),version:workspaceDocumentVersionSchema}).strict(),
  z.object({...metadata,kind:z.literal('workspace.document.moved'),destination:workspaceDocumentPathSchema,version:workspaceDocumentVersionSchema}).strict(),
  z.object({...metadata,kind:z.literal('workspace.document.deleted')}).strict()
] as const;
export const workspaceDocumentResultSchema=z.discriminatedUnion('kind',workspaceDocumentResultSchemas);
export type WorkspaceDocumentResult=z.infer<typeof workspaceDocumentResultSchema>;
