import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { ModelQualityBenchmark } from '../src/model/capability/ModelQualityBenchmark.js';
import { MODEL_QUALITY_CASES,MODEL_QUALITY_LIFETIME_MS,assertModelQualityReport,modelQualitySummary } from '../src/model/capability/ModelQualityContracts.js';
import { ModelCapabilityRegistry } from '../src/model/capability/ModelCapabilityRegistry.js';
import { unknownQualification } from '../src/model/capability/ModelCapabilityQualification.js';
import type { ExactAgentModelInferenceRuntime,ExactAgentModelInferenceResult } from '../src/control/ports/AgentModelInference.js';

const fingerprint=`sha256:${'a'.repeat(64)}`;
const binding={providerId:'fixture',modelId:'model',settingsRevision:1};
const now=new Date('2026-10-04T03:00:00.000Z');
const owners:ModelCapabilityRegistry[]=[];const roots:string[]=[];
afterEach(()=>{for(const owner of owners.splice(0))owner.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(path.join(os.tmpdir(),'ariadne-quality-'));roots.push(root);
  const file=path.join(root,'capability.db');const registry=new ModelCapabilityRegistry(file);owners.push(registry);
  registry.registerFingerprint(binding.providerId,binding.modelId,fingerprint);
  registry.write({...unknownQualification({...binding,fingerprint}),textResponse:'qualified'});
  const infer=vi.fn<ExactAgentModelInferenceRuntime['inferExact']>(async(request)=>{
    const prompt=request.messages[1]!.content[0]!;
    const task=MODEL_QUALITY_CASES.find(task=>prompt.type==='text'&&task.prompt===prompt.text)!;
    return completed(JSON.stringify(task.expected));
  });
  const models={inferExact:infer} as unknown as ExactAgentModelInferenceRuntime;
  const benchmark=new ModelQualityBenchmark(models,registry,()=>now);
  const run=(signal=new AbortController().signal)=>benchmark.run({binding,fingerprint,signal});
  return {registry,file,infer,benchmark,run};
}
function completed(text:string):ExactAgentModelInferenceResult {
  return {status:'completed',contentBlocks:[{type:'text',text}],replay:{adapter:'fixture',finishReason:'stop'}};
}
describe('fixed model quality benchmark authority',()=>{
  it('sends six bounded synthetic requests and persists exact score across a cold owner',async()=>{
    const f=fixture();const report=await f.run();expect(report.score).toBe(1);expect(report.passed).toBe(6);
    expect(f.infer).toHaveBeenCalledTimes(6);
    for(const [request] of f.infer.mock.calls){expect(request.tools).toEqual([]);expect(request.messages).toHaveLength(2);
      expect(request.sampling).toEqual({temperature:0,maxOutputTokens:512});expect(request.chunkObserver).toBeUndefined();}
    expect(f.registry.current('fixture','model')?.textResponse).toBe('qualified');
    f.registry.close();const reopened=new ModelCapabilityRegistry(f.file);owners.push(reopened);
    reopened.registerFingerprint('fixture','model',fingerprint);expect(reopened.current('fixture','model')?.quality).toEqual(report);
    expect(modelQualitySummary(report,now).state).toBe('current');
    expect(modelQualitySummary(report,new Date(now.getTime()+MODEL_QUALITY_LIFETIME_MS)).state).toBe('expired');
    reopened.registerFingerprint('fixture','model',`sha256:${'b'.repeat(64)}`);expect(reopened.current('fixture','model')?.quality).toBeUndefined();
  });
  it('records mismatches, malformed JSON, unavailable bindings and transport errors without inventing passes',async()=>{
    const f=fixture();f.infer.mockResolvedValueOnce(completed('{"value":0}')).mockResolvedValueOnce(completed('```json\n{}\n```'))
      .mockResolvedValueOnce({status:'binding_unavailable'}).mockRejectedValueOnce(new Error('transport failed'));
    const report=await f.run();expect(report.passed).toBe(2);expect(report.score).toBe(2/6);
    expect(report.cases.map(entry=>entry.failureCode)).toEqual(['answer_mismatch','invalid_response','binding_unavailable','provider_failed',null,null]);
    expect(JSON.stringify(report)).not.toContain('transport failed');
  });
  it('rejects unexpected tool calls even when accompanying text is correct',async()=>{
    const f=fixture();const first=completed(JSON.stringify(MODEL_QUALITY_CASES[0]!.expected));
    if(first.status!=='completed')throw new Error('fixture');
    f.infer.mockResolvedValueOnce({...first,contentBlocks:[...first.contentBlocks,{type:'tool_call',toolCallId:'attempt',providerToolName:'unknown',input:{}}]});
    expect((await f.run()).cases[0]!.failureCode).toBe('invalid_response');
  });
  it('joins cancellation before releasing ownership and leaves the previous score unchanged',async()=>{
    const f=fixture();const previous=await f.run();const controller=new AbortController();let finish!:()=>void;
    f.infer.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return completed('{}');});
    const pending=f.run(controller.signal);const rejected=expect(pending).rejects.toThrow();
    await expect(f.run()).rejects.toThrow('already_running');controller.abort();
    expect(f.registry.current('fixture','model')?.quality).toEqual(previous);finish();await rejected;
    expect(f.registry.current('fixture','model')?.quality).toEqual(previous);
    expect((await f.run()).score).toBe(1);
  });
  it('discards an in-flight measurement when the model fingerprint changes',async()=>{
    const f=fixture();const previous=await f.run();
    f.infer.mockImplementationOnce(async()=>{f.registry.registerFingerprint('fixture','model',`sha256:${'b'.repeat(64)}`);return completed('{}');});
    await expect(f.run()).rejects.toThrow('binding_changed');expect(f.registry.read('fixture','model',fingerprint).quality).toEqual(previous);
  });
  it('preserves qualification changes made while inference is in progress',async()=>{
    const f=fixture();f.infer.mockImplementationOnce(async()=>{
      f.registry.write({...f.registry.read('fixture','model',fingerprint),streamingText:'qualified',testedAt:now.toISOString()});
      return completed(JSON.stringify(MODEL_QUALITY_CASES[0]!.expected));
    });await f.run();expect(f.registry.current('fixture','model')).toMatchObject({streamingText:'qualified',testedAt:now.toISOString(),quality:{score:1}});
  });
  it('rejects inconsistent private evidence and expires old benchmark versions',async()=>{
    const report=await fixture().run();expect(()=>assertModelQualityReport({...report,score:0})).toThrow();
    expect(()=>assertModelQualityReport({...report,cases:report.cases.map(()=>report.cases[0]!)})).toThrow();
    expect(()=>assertModelQualityReport({...report,validUntil:now.toISOString()})).toThrow();
    expect(modelQualitySummary({...report,benchmarkDigest:`sha256:${'f'.repeat(64)}`},now).state).toBe('expired');
  });
  it('does not let stale qualification snapshots erase a newer quality report',async()=>{
    const f=fixture();const old=f.registry.read('fixture','model',fingerprint);const measured=await f.run();
    f.registry.write({...old,nativeToolCalls:'qualified'});
    expect(f.registry.current('fixture','model')).toMatchObject({nativeToolCalls:'qualified',quality:measured});
    const stale={...measured,evaluatedAt:'2026-10-03T03:00:00.000Z',validUntil:'2026-11-02T03:00:00.000Z'};
    f.registry.write({...old,quality:stale});expect(f.registry.current('fixture','model')?.quality).toEqual(measured);
  });
});
