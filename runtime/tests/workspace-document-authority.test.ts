import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { workspaceDocumentCommandSchema,type WorkspaceDocumentCommand } from '@ariadne/protocol/public';
import { LocalWorkspaceFileService } from '../src/adapters/filesystem/LocalWorkspaceFileService.js';
import { ProductionWorkspaceDocumentAuthority } from '../src/composition/ProductionWorkspaceDocumentAuthority.js';
import { WorkspaceDocumentPublicCommandHandler,createWorkspaceDocumentCommandOwners } from '../src/composition/WorkspaceDocumentPublicCommandHandler.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';
const roots:string[]=[];const signal=new AbortController().signal;
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(path.join(os.tmpdir(),'ariadne-document-'));roots.push(root);const files=new LocalWorkspaceFileService();
  const authority=new ProductionWorkspaceDocumentAuthority(new Map([['workspace-a',{rootPath:root,access:'write' as const}],['readonly',{rootPath:root,access:'read' as const}]]),files);
  const command=(kind:WorkspaceDocumentCommand['kind'],fields:Record<string,unknown>={})=>workspaceDocumentCommandSchema.parse({kind,contractVersion:'5.0',workspaceId:'workspace-a',path:'note.txt',...fields});
  return {root,files,authority,command};
}
describe('explicit user workspace document authority',()=>{
  it('reports absent read, move and delete sources as known completed errors without leaking paths',async()=>{
    const f=fixture();const handler=new WorkspaceDocumentPublicCommandHandler(f.authority);
    for(const command of [f.command('workspace.document.read'),f.command('workspace.document.move',{expectedVersion:'workspace-file-v1:'+'a'.repeat(64),destination:'target.txt'}),
      f.command('workspace.document.delete',{expectedVersion:'workspace-file-v1:'+'a'.repeat(64)})]) {
      const envelope:RuntimeCommandEnvelope={commandId:command.kind,correlationId:'correlation',command,deadlineAt:new Date(Date.now()+10_000).toISOString(),signal};
      const result=await handler.execute(envelope,command);
      expect(result).toMatchObject({settlement:'completed',outcome:{ok:false,error:{code:'workspace_file_not_found'}}});
      expect(JSON.stringify(result)).not.toContain(f.root);
    }
  });
  it('creates, reads, saves exact UTF-8/CRLF, moves and deletes actual files with freshness',async()=>{
    const f=fixture();const content='第一行\r\n第二行😀\r\n';
    const created=await f.authority.execute(f.command('workspace.document.save',{expectedVersion:null,content}),signal);
    expect(created.kind).toBe('workspace.document.saved');expect(readFileSync(path.join(f.root,'note.txt'),'utf8')).toBe(content);
    const read=await f.authority.execute(f.command('workspace.document.read'),signal);if(read.kind!=='workspace.document.read_result')throw new Error('fixture');
    expect(read).toMatchObject({content,writable:true,byteLength:Buffer.byteLength(content)});
    const saved=await f.authority.execute(f.command('workspace.document.save',{expectedVersion:read.version,content:content+'末尾'}),signal);
    if(saved.kind!=='workspace.document.saved')throw new Error('fixture');
    const moved=await f.authority.execute(f.command('workspace.document.move',{expectedVersion:saved.version,destination:'folder/new.txt'}),signal);
    if(moved.kind!=='workspace.document.moved')throw new Error('fixture');expect(existsSync(path.join(f.root,'note.txt'))).toBe(false);
    await f.authority.execute(f.command('workspace.document.delete',{path:'folder/new.txt',expectedVersion:moved.version}),signal);
    expect(existsSync(path.join(f.root,'folder/new.txt'))).toBe(false);
  });
  it('shares file serialization with the existing file owner and rejects one of two stale concurrent writes',async()=>{
    const f=fixture();const target=path.join(f.root,'note.txt');writeFileSync(target,'original');
    const observed=await f.files.readText({absolutePath:target,maxBytes:262_144,signal});
    const outcomes=await Promise.allSettled([f.authority.execute(f.command('workspace.document.save',{expectedVersion:observed.version,content:'user'}),signal),
      f.files.writeText({absolutePath:target,content:'tool',expected:{kind:'replace_if_version',version:observed.version},maxBytes:262_144,signal})]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'workspace_file_stale_version'}});
  });
  it('does not overwrite existing destinations or stale source versions',async()=>{
    const f=fixture();writeFileSync(path.join(f.root,'note.txt'),'original');writeFileSync(path.join(f.root,'target.txt'),'keep');
    const read=await f.files.readText({absolutePath:path.join(f.root,'note.txt'),maxBytes:262_144,signal});
    await expect(f.authority.execute(f.command('workspace.document.move',{expectedVersion:read.version,destination:'target.txt'}),signal)).rejects.toThrow();
    expect(readFileSync(path.join(f.root,'target.txt'),'utf8')).toBe('keep');
    writeFileSync(path.join(f.root,'note.txt'),'external');
    await expect(f.authority.execute(f.command('workspace.document.delete',{expectedVersion:read.version}),signal)).rejects.toThrow('stale_version');
    expect(readFileSync(path.join(f.root,'note.txt'),'utf8')).toBe('external');
  });
  it('enforces exact workspace identity, read-only roots, size and text format',async()=>{
    const f=fixture();writeFileSync(path.join(f.root,'note.txt'),'read me');
    await expect(f.authority.execute(f.command('workspace.document.read',{workspaceId:'unknown'}),signal)).rejects.toThrow('scope_unknown');
    expect(await f.authority.execute(f.command('workspace.document.read',{workspaceId:'readonly'}),signal)).toMatchObject({writable:false});
    await expect(f.authority.execute(f.command('workspace.document.save',{workspaceId:'readonly',expectedVersion:null,content:'no'}),signal)).rejects.toThrow('read_only');
    await expect(f.authority.execute(f.command('workspace.document.save',{expectedVersion:null,path:'large.txt',content:'汉'.repeat(90_000)}),signal)).rejects.toThrow('too_large');
    expect(existsSync(path.join(f.root,'large.txt'))).toBe(false);
    writeFileSync(path.join(f.root,'note.txt'),Buffer.from([0xff,0x00]));await expect(f.authority.execute(f.command('workspace.document.read'),signal)).rejects.toThrow('not_text');
  });
  it('rejects a junction escape and keeps public errors free of private root paths',async()=>{
    const f=fixture();const foreign=mkdtempSync(path.join(os.tmpdir(),'ariadne-document-foreign-'));roots.push(foreign);writeFileSync(path.join(foreign,'note.txt'),'private');
    symlinkSync(foreign,path.join(f.root,'escape'),'junction');
    const handler=new WorkspaceDocumentPublicCommandHandler(f.authority);const command=f.command('workspace.document.read',{path:'escape/note.txt'});
    const envelope:RuntimeCommandEnvelope={commandId:'read',correlationId:'correlation',command,deadlineAt:new Date(Date.now()+10_000).toISOString(),signal};
    const result=await handler.execute(envelope,command);expect(result.outcome.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(foreign);
    await expect(f.authority.execute(f.command('workspace.document.save',{path:'escape/new.txt',expectedVersion:null,content:'no'}),signal)).rejects.toThrow();
    expect(existsSync(path.join(foreign,'new.txt'))).toBe(false);
  });
  it('does not claim an uncertain filesystem mutation is uncommitted or allow its blind replay',async()=>{
    const f=fixture();const [owner]=createWorkspaceDocumentCommandOwners(new WorkspaceDocumentPublicCommandHandler(f.authority));
    const command=f.command('workspace.document.save',{expectedVersion:null,content:'new'});
    const envelope:RuntimeCommandEnvelope={commandId:'uncertain',correlationId:'correlation',command,deadlineAt:new Date(Date.now()+10_000).toISOString(),signal};
    expect(await owner!.reconcile(envelope)).toBeNull();
    expect(await owner!.reconcile({...envelope,command:f.command('workspace.document.read')})).toEqual({kind:'not_committed'});
  });
  it('isolates actual invalid file content while another file remains writable through the same owner',async()=>{
    const f=fixture();writeFileSync(path.join(f.root,'note.txt'),Buffer.from([0xff,0x00]));
    const handler=new WorkspaceDocumentPublicCommandHandler(f.authority);
    const bad=f.command('workspace.document.read'), good=f.command('workspace.document.save',{path:'independent.txt',expectedVersion:null,content:'independent content'});
    const envelope=(command:WorkspaceDocumentCommand,id:string):RuntimeCommandEnvelope=>({commandId:id,correlationId:id,command,
      deadlineAt:new Date(Date.now()+10_000).toISOString(),signal});
    expect(await handler.execute(envelope(bad,'bad-file'),bad)).toMatchObject({settlement:'completed',outcome:{ok:false,error:{code:'workspace_file_not_text'}}});
    expect(await handler.execute(envelope(good,'independent-file'),good)).toMatchObject({settlement:'completed',outcome:{ok:true}});
    expect(readFileSync(path.join(f.root,'independent.txt'),'utf8')).toBe('independent content');
    expect(readFileSync(path.join(f.root,'note.txt'))).toEqual(Buffer.from([0xff,0x00]));
  });
});
