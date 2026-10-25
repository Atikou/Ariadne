import { describe,expect,it } from 'vitest';
import { modelQualitySummarySchema,runtimeCommandSchema,runtimeResultSchema } from '../src/public.js';
const quality={benchmarkId:'ariadne-text-quality-v1' as const,benchmarkDigest:`sha256:${'a'.repeat(64)}`,score:1,passed:6,total:6,
  evaluatedAt:'2026-10-04T03:00:00.000Z',validUntil:'2026-11-03T03:00:00.000Z',state:'current' as const};
describe('public model quality contracts',()=>{
  it('accepts only exact commands and bounded evidence summaries',()=>{
    const command={kind:'model.quality.evaluate',contractVersion:'5.0',modelId:'model'};
    expect(runtimeCommandSchema.parse(command)).toEqual(command);
    expect(runtimeCommandSchema.safeParse({...command,history:[]}).success).toBe(false);
    expect(runtimeResultSchema.parse({kind:'model.quality.completed',modelId:'model',quality})).toMatchObject({quality});
  });
  it('rejects fake scores, invalid time ranges and private per-case output',()=>{
    for(const invalid of [{...quality,score:0.5},{...quality,total:7},{...quality,validUntil:quality.evaluatedAt},{...quality,cases:[]},{...quality,evaluatedAt:'2026-02-30T00:00:00.000Z'}])
      expect(modelQualitySummarySchema.safeParse(invalid).success).toBe(false);
  });
});
