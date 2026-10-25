import { describe,expect,it,vi } from 'vitest';
import { runtimeCommandSchema,type RuntimeResult } from '@ariadne/protocol/public';
import { ModelFeatureStore } from '../src/renderer/src/core/runtime/features/model-feature-store';
const quality={benchmarkId:'ariadne-text-quality-v1' as const,benchmarkDigest:`sha256:${'a'.repeat(64)}`,score:1,passed:6,total:6 as const,
  evaluatedAt:'2026-10-04T03:00:00.000Z',validUntil:'2026-11-03T03:00:00.000Z',state:'current' as const};
function fixture(result:RuntimeResult) {
  const execute=vi.fn(async(input:unknown)=>{runtimeCommandSchema.parse(input);return result;});const synchronize=vi.fn(async()=>{});
  const source={getSnapshot:()=>({models:[],modelsReadReady:true}),subscribe:()=>()=>{}};
  return {store:new ModelFeatureStore(source,{execute},synchronize),execute,synchronize};
}
describe('model quality public feature store',()=>{
  it('serializes the strict command and synchronizes the resulting public score',async()=>{
    const f=fixture({kind:'model.quality.completed',modelId:'model',quality});await f.store.evaluateQuality('model');
    expect(f.execute).toHaveBeenCalledWith({kind:'model.quality.evaluate',contractVersion:'5.0',modelId:'model'});expect(f.synchronize).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong result type or foreign model without synchronizing',async()=>{
    for(const result of [{kind:'model.quality.completed',modelId:'other',quality},{kind:'model.availability.completed',modelId:'model',available:true}] as RuntimeResult[]) {
      const f=fixture(result);await expect(f.store.evaluateQuality('model')).rejects.toThrow('result_invalid');expect(f.synchronize).not.toHaveBeenCalled();
    }
  });
});
