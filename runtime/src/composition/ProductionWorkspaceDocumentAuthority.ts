import { WORKSPACE_DOCUMENT_MAX_BYTES,type WorkspaceDocumentCommand,type WorkspaceDocumentResult } from '@ariadne/protocol/public';
import type { WorkspaceDocumentAuthority } from '../control/ports/WorkspaceDocumentAuthority.js';
import type { WorkspaceFileService,WorkspaceFileVersion } from '../control/ports/WorkspaceFileService.js';
import { LocalWorkspaceFileError } from '../adapters/filesystem/LocalWorkspaceFileService.js';
import { resolveExistingWorkspacePath,resolveWritableWorkspacePath,type WorkspaceBinding } from './first-party-tools/FirstPartyAgentToolSupport.js';

export class ProductionWorkspaceDocumentAuthority implements WorkspaceDocumentAuthority {
  public constructor(private readonly roots:ReadonlyMap<string,WorkspaceBinding>,private readonly files:WorkspaceFileService) {}
  public async execute(command:WorkspaceDocumentCommand,signal:AbortSignal):Promise<WorkspaceDocumentResult> {
    signal.throwIfAborted();const workspace=this.roots.get(command.workspaceId);
    if(!workspace)throw new Error('workspace_scope_unknown');
    const identity={workspaceId:command.workspaceId,path:command.path};
    if(command.kind==='workspace.document.read') {
      const absolutePath=await this.existingPath(workspace.rootPath,command.path);
      const result=await this.files.readText({absolutePath,maxBytes:WORKSPACE_DOCUMENT_MAX_BYTES,signal});
      return {...identity,kind:'workspace.document.read_result',content:result.content,version:result.version,byteLength:result.byteLength,writable:workspace.access==='write'};
    }
    if(workspace.access!=='write')throw new Error('workspace_is_read_only');
    if(command.kind==='workspace.document.save') {
      const absolutePath=await resolveWritableWorkspacePath(workspace.rootPath,command.path);
      const result=await this.files.writeText({absolutePath,content:command.content,expected:command.expectedVersion===null?{kind:'create_if_absent'}:
        {kind:'replace_if_version',version:command.expectedVersion as WorkspaceFileVersion},maxBytes:WORKSPACE_DOCUMENT_MAX_BYTES,signal});
      return {...identity,kind:'workspace.document.saved',operation:result.operation,version:result.version,byteLength:result.byteLength};
    }
    const absolutePath=await this.existingPath(workspace.rootPath,command.path);
    if(command.kind==='workspace.document.move') {
      const destinationAbsolutePath=await resolveWritableWorkspacePath(workspace.rootPath,command.destination);
      const result=await this.files.moveText({sourceAbsolutePath:absolutePath,destinationAbsolutePath,expectedVersion:command.expectedVersion as WorkspaceFileVersion,maxBytes:WORKSPACE_DOCUMENT_MAX_BYTES,signal});
      return {...identity,kind:'workspace.document.moved',destination:command.destination,version:result.version,byteLength:result.byteLength};
    }
    const result=await this.files.deleteText({absolutePath,expectedVersion:command.expectedVersion as WorkspaceFileVersion,maxBytes:WORKSPACE_DOCUMENT_MAX_BYTES,signal});
    return {...identity,kind:'workspace.document.deleted',byteLength:result.byteLength};
  }
  private async existingPath(root:string,path:string):Promise<string> {
    try{return await resolveExistingWorkspacePath(root,path);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new LocalWorkspaceFileError('workspace_file_not_found');throw error;}
  }
}
