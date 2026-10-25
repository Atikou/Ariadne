import { describe,expect,it } from 'vitest';
import { runtimeCommandSchema,runtimeResultSchema,workspaceDocumentPathSchema } from '../src/public.js';
const version=`workspace-file-v1:${'a'.repeat(64)}`;
describe('workspace text document contracts',()=>{
  it('requires contained portable paths and rejects device names, ADS and traversal',()=>{
    expect(workspaceDocumentPathSchema.parse('文件/笔记.txt')).toBe('文件/笔记.txt');
    for(const path of ['', '../secret','/absolute','C:/secret','a\\b','a//b','a/./b','file:stream','CON.txt','folder/NUL','file.','file ','a?b'])
      expect(workspaceDocumentPathSchema.safeParse(path).success,path).toBe(false);
  });
  it('requires explicit freshness or create-if-absent and exact field sets',()=>{
    const command={kind:'workspace.document.save',contractVersion:'5.0',workspaceId:'workspace-a',path:'notes.txt',content:'正文',expectedVersion:null};
    expect(runtimeCommandSchema.parse(command)).toEqual(command);
    expect(runtimeCommandSchema.parse({...command,expectedVersion:version})).toMatchObject({expectedVersion:version});
    expect(runtimeCommandSchema.safeParse({...command,expectedVersion:undefined}).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({...command,absolutePath:'C:/secret'}).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({...command,content:'x'.repeat(262_145)}).success).toBe(false);
  });
  it('exposes text only in explicit results and mutations return metadata',()=>{
    expect(runtimeResultSchema.parse({kind:'workspace.document.read_result',workspaceId:'workspace-a',path:'notes.txt',content:'正文',byteLength:6,version,writable:false})).toMatchObject({writable:false});
    expect(runtimeResultSchema.safeParse({kind:'workspace.document.deleted',workspaceId:'workspace-a',path:'notes.txt',byteLength:6,content:'正文'}).success).toBe(false);
  });
});
