import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DispatchExactAgentModelInferenceRequest, ExactAgentModelInferenceRuntime } from '../../control/ports/AgentModelInference.js';
import type { ModelCapabilityAuthority } from './ModelCapabilityAuthority.js';
import { MODEL_QUALITY_BENCHMARK_DIGEST,MODEL_QUALITY_CASES,MODEL_QUALITY_LIFETIME_MS,MODEL_QUALITY_SAMPLING,
  assertModelQualityReport,type ModelQualityReport } from './ModelQualityContracts.js';

/** Sends only six fixed synthetic tasks. Never supplies user history or executes Tools. */
export class ModelQualityBenchmark {
  private readonly activeModels = new Set<string>();
  public constructor(private readonly models:ExactAgentModelInferenceRuntime,private readonly registry:ModelCapabilityAuthority,
    private readonly now=()=>new Date()) {}
  public async run(input:{readonly binding:DispatchExactAgentModelInferenceRequest['binding'];readonly fingerprint:string;readonly signal:AbortSignal}):Promise<ModelQualityReport> {
    const key=JSON.stringify([input.binding.providerId,input.binding.modelId]);
    if(this.activeModels.has(key))throw new Error('model_quality_evaluation_already_running');
    this.activeModels.add(key);
    try {return await this.evaluate(input);}finally {this.activeModels.delete(key);}
  }
  private async evaluate(input:{readonly binding:DispatchExactAgentModelInferenceRequest['binding'];readonly fingerprint:string;readonly signal:AbortSignal}):Promise<ModelQualityReport> {
    const signal=AbortSignal.any([input.signal,AbortSignal.timeout(60_000)]);
    const assertBinding=()=>{signal.throwIfAborted();if(this.registry.currentFingerprint(input.binding.providerId,input.binding.modelId)!==input.fingerprint)
      throw new Error('model_quality_binding_changed');};
    const cases:ModelQualityReport['cases']=[];
    for(const task of MODEL_QUALITY_CASES) {
      assertBinding();let output='';let failureCode:ModelQualityReport['cases'][number]['failureCode']='provider_failed';
      try {
        const result=await this.models.inferExact({binding:input.binding,messages:[{role:'system',content:[{type:'text',text:'You are completing a fixed synthetic Ariadne quality benchmark. Follow the user output format exactly.'}]},
          {role:'user',content:[{type:'text',text:task.prompt}]}],tools:[],sampling:MODEL_QUALITY_SAMPLING,signal});
        assertBinding();
        if(result.status!=='completed') failureCode='binding_unavailable';
        else {
          output=result.contentBlocks.filter(block=>block.type==='text').map(block=>block.text).join('');
          if(output.length>16_384||result.contentBlocks.some(block=>block.type==='tool_call')) failureCode='invalid_response';
          else {try {failureCode=isDeepStrictEqual(JSON.parse(output),task.expected)?null:'answer_mismatch';}
            catch {failureCode='invalid_response';}}
        }
      } catch(error) {assertBinding();failureCode='provider_failed';}
      cases.push({caseId:task.id,passed:failureCode===null,failureCode,outputDigest:`sha256:${createHash('sha256').update(output).digest('hex')}`});
    }
    assertBinding();const clock=this.now();if(!Number.isFinite(clock.getTime()))throw new Error('model_quality_clock_invalid');
    const passed=cases.filter(entry=>entry.passed).length;
    const report=assertModelQualityReport({benchmarkId:'ariadne-text-quality-v1',benchmarkDigest:MODEL_QUALITY_BENCHMARK_DIGEST,
      score:passed/cases.length,passed,total:6,evaluatedAt:clock.toISOString(),validUntil:new Date(clock.getTime()+MODEL_QUALITY_LIFETIME_MS).toISOString(),cases});
    // Re-read after inference so concurrent qualification updates are preserved.
    const current=this.registry.read(input.binding.providerId,input.binding.modelId,input.fingerprint);
    if(current.quality && Date.parse(current.quality.evaluatedAt)>clock.getTime())throw new Error('model_quality_clock_regressed');
    this.registry.write({...current,quality:report});return report;
  }
}
