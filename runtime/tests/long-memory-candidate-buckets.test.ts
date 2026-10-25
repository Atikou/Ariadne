import { describe,expect,it } from 'vitest';
import { memoryVectorBuckets,memoryQueryBuckets,memoryCandidateLimit } from '../src/adapters/persistence/LongMemoryCandidateBuckets.js';

describe('bounded memory vector candidate addressing',()=>{
  it('uses deterministic scale-invariant bucket identity and bounded one-bit probes',()=>{
    const vector=[1,-2,3,-4,0.5];
    expect(memoryVectorBuckets(vector)).toEqual(memoryVectorBuckets(vector.map(value=>value*7)));
    const probes=memoryQueryBuckets(vector);expect(probes).toHaveLength(52);
    expect(new Set(probes.map(probe=>probe.table+':'+probe.bucket)).size).toBe(52);
    for(const table of [0,1,2,3]){
      const direct=probes.find(probe=>probe.table===table&&probe.distance===0)!;
      for(const neighbor of probes.filter(probe=>probe.table===table&&probe.distance===1)){
        const changed=direct.bucket^neighbor.bucket;expect(changed>0&&(changed&(changed-1))===0).toBe(true);
      }
    }
  });
  it('bounds decoded coordinate count for large dimensions and rejects invalid vectors',()=>{
    expect(memoryCandidateLimit(256,1000)).toBe(128);
    expect(memoryCandidateLimit(65_536,1000)).toBe(2);
    expect(memoryCandidateLimit(256,20)).toBe(20);
    expect(()=>memoryVectorBuckets([NaN])).toThrow('invalid');
    expect(()=>memoryVectorBuckets([])).toThrow('invalid');
    expect(()=>memoryCandidateLimit(0,20)).toThrow('invalid');
  });
});
