import type { WorkspaceDocumentCommand } from '@ariadne/protocol/public';
import { LocalWorkspaceFileError } from '../adapters/filesystem/LocalWorkspaceFileService.js';
import type { WorkspaceDocumentAuthority } from '../control/ports/WorkspaceDocumentAuthority.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import { completedPublicError } from './AgentPublicCommandFailures.js';
import { defineAgentPublicCommandOwner,type AgentPublicCommandOwner } from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import { WORKSPACE_DOCUMENT_FAILURE_MESSAGES as messages } from '@ariadne/protocol/public';

const kinds=['workspace.document.read','workspace.document.save','workspace.document.move','workspace.document.delete'] as const;
export class WorkspaceDocumentPublicCommandHandler {
  public constructor(private readonly authority:WorkspaceDocumentAuthority|undefined) {}
  public async execute(envelope:RuntimeCommandEnvelope,command:WorkspaceDocumentCommand):Promise<RuntimeApplicationCommandResult> {
    if(!this.authority)return completedPublicError(envelope,'workspace_documents_unavailable','文件编辑服务不可用。',false);
    try {const result=await this.authority.execute(command,envelope.signal);return {settlement:'completed',outcome:{ok:true,result}};}
    catch(error) {
      if(envelope.signal.aborted)throw error;
      const code=error instanceof LocalWorkspaceFileError?error.code:error instanceof Error?error.message:'';
      if(Object.hasOwn(messages,code))return completedPublicError(envelope,code,messages[code]!,false);
      // A filesystem mutation may have published before an I/O failure. No
      // durable file receipt exists here, so never claim it did not commit.
      if(command.kind!=='workspace.document.read')throw error;
      return completedPublicError(envelope,'workspace_document_read_failed','无法读取此工作区文件。',true);
    }
  }
}
export function createWorkspaceDocumentCommandOwners(handler:WorkspaceDocumentPublicCommandHandler):readonly AgentPublicCommandOwner[] {
  return [defineAgentPublicCommandOwner('workspace-documents',kinds,(envelope,command)=>handler.execute(envelope,command),
    async(_envelope,command)=>command.kind==='workspace.document.read'?{kind:'not_committed'}:null)];
}
