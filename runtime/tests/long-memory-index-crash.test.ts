import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,it,expect} from 'vitest';
import {SqliteLongMemoryStore} from '../src/adapters/persistence/SqliteLongMemoryStore.js';

function run(phase:string,root:string){
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/long-memory-index-child.ts',import.meta.url)),phase,root],
    {cwd:process.cwd(),stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
  const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  const message=new Promise<Record<string,unknown>>((resolve,reject)=>{
    child.once('message',value=>{if(typeof value==='object'&&value!==null)resolve(value as Record<string,unknown>);else reject(new Error('index_child_message_invalid'));});
    child.once('error',reject);child.once('exit',()=>reject(new Error('index_child_exited_before_evidence:'+stderr)));
  });
  return {child,exit,message};
}
async function stop(child:ChildProcess){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
describe('actual process interruption of the sole memory index owner',()=>{
  it('recovers a persisted claimed job after OS kill without replaying original authority commands',async()=>{
    const root=mkdtempSync(path.join(tmpdir(),'ariadne-index-kill-'));let prepared:ReturnType<typeof run>|null=null,reopened:ReturnType<typeof run>|null=null;
    try{
      prepared=run('prepare',root);expect(await prepared.message).toMatchObject({kind:'leased',leased:1,computations:1});
      expect(()=>new SqliteLongMemoryStore(root)).toThrow('sqlite_owner_lease_unavailable');
      prepared.child.kill('SIGKILL');await prepared.exit;
      reopened=run('verify',root);const evidence=await reopened.message;
      expect(evidence).toMatchObject({kind:'verified',passed:true,receipts:3,computations:3});
      expect(evidence.versions).toEqual([0,1,2].map(index=>({memory_id:'memory-'+index,version:1})));
      expect(await reopened.exit).toBe(0);
      writeFileSync(path.resolve('../artifacts/todo-remediation/t08-background-owner-crash.json'),JSON.stringify({passed:true,
        evidence:'actual own Node process SIGKILL and reopened SQLite authority/index; deterministic embedding adapter fixture',...evidence},null,2)+'\n');
    }finally{
      if(prepared){await stop(prepared.child);await prepared.exit;}if(reopened){await stop(reopened.child);await reopened.exit;}
      const relative=path.relative(tmpdir(),root);if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith('ariadne-index-kill-'))throw new Error('index_crash_cleanup_scope_invalid');
      rmSync(root,{recursive:true,force:true});
    }
  },20000);
});
