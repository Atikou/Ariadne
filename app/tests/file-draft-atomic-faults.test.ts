import { afterEach, describe, expect, it, vi } from 'vitest';
import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDraftRepository } from '../src/main/persistence/file-draft-repository';

vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,writeFile:vi.fn(actual.writeFile),rename:vi.fn(actual.rename)};
});
const roots:string[]=[];
const cipher={encrypt:(text:string)=>Buffer.from(text).toString('base64'),decrypt:(text:string)=>Buffer.from(text,'base64').toString('utf8')};
afterEach(async()=>{vi.mocked(disk.writeFile).mockReset();vi.mocked(disk.rename).mockReset();
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(disk.writeFile).mockImplementation(actual.writeFile);vi.mocked(disk.rename).mockImplementation(actual.rename);
  for(const root of roots.splice(0))await actual.rm(root,{recursive:true,force:true});
});
describe('private file draft atomic failure boundary',()=>{
  it.each(['write','rename'] as const)('injected ENOSPC at %s retains the last acknowledged catalog and disables later writes',async point=>{
    const root=await disk.mkdtemp(join(tmpdir(),'ariadne-file-draft-fault-'));roots.push(root);
    const path=join(root,'file-drafts.json'),repository=new FileDraftRepository(path,cipher);await repository.initialize();
    const a={draftId:crypto.randomUUID(),workspaceId:'workspace-a',path:'notes.txt',revision:1,updatedAt:new Date().toISOString(),
      content:'PROTECTED_A',originalContent:'baseline',version:`workspace-file-v1:${'a'.repeat(64)}`,exists:true,writable:true,pendingMutation:null};
    const acknowledged=await repository.replace({expectedRevision:0,records:[a]}),before=await disk.readFile(path,'utf8');
    // Explicit fault injection, not a claim that the user's drive was filled.
    const fault=Object.assign(new Error('owned test ENOSPC'),{code:'ENOSPC'});
    if(point==='write')vi.mocked(disk.writeFile).mockRejectedValueOnce(fault);
    else vi.mocked(disk.rename).mockRejectedValueOnce(fault);
    await expect(repository.replace({expectedRevision:acknowledged.revision,records:[{...a,revision:2,content:'UNPROTECTED_B'}]})).rejects.toThrow('storage_unavailable');
    const calls=vi.mocked(disk.writeFile).mock.calls.length;
    await expect(repository.replace({expectedRevision:acknowledged.revision,records:[]})).rejects.toThrow('storage_unavailable');
    expect(vi.mocked(disk.writeFile).mock.calls.length).toBe(calls);
    await expect(repository.list()).rejects.toThrow('storage_unavailable');expect(await disk.readFile(path,'utf8')).toBe(before);
    const reopened=new FileDraftRepository(path,cipher);await reopened.initialize();expect(await reopened.list()).toEqual(acknowledged);
  });
});
