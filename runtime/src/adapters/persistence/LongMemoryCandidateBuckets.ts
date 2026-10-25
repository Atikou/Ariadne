/** Storage-owned approximate candidate algorithm; never an exhaustive scan. */
export const MEMORY_CANDIDATE_ALGORITHM='signed-sparse-lsh-v1:4x12x16';
export const MEMORY_CANDIDATE_TABLES=4;
export const MEMORY_CANDIDATE_BITS=12;
export const MEMORY_MAX_CANDIDATES=128;
export const MEMORY_MAX_QUERY_COORDINATES=131_072;
export interface MemoryCandidateBucket { readonly table:number;readonly bucket:number;readonly distance:number; }

function mix(value:number):number {
  let x=value>>>0;x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return (x^(x>>>16))>>>0;
}
export function memoryVectorBuckets(vector:readonly number[]):readonly number[] {
  if(!Number.isSafeInteger(vector.length)||vector.length<1||vector.length>65_536||!vector.every(Number.isFinite))
    throw new Error('long_memory_index_vector_invalid');
  // Scale before summation so large finite coordinates cannot overflow a
  // signed projection. The candidate address depends on direction only.
  const scale=vector.reduce((maximum,value)=>Math.max(maximum,Math.abs(value)),0)||1;
  return Array.from({length:MEMORY_CANDIDATE_TABLES},(_,table)=>{
    let bucket=0;
    for(let bit=0;bit<MEMORY_CANDIDATE_BITS;bit++){
      let projection=0;
      for(let sample=0;sample<16;sample++){
        const seed=mix((table+1)*0x9e3779b1^(bit+1)*0x85ebca6b^(sample+1)*0xc2b2ae35);
        projection+=(vector[seed%vector.length]!/scale)*(seed&0x80000000?-1:1);
      }
      if(projection>=0)bucket|=1<<bit;
    }
    return bucket;
  });
}
export function memoryQueryBuckets(vector:readonly number[]):readonly MemoryCandidateBucket[] {
  return memoryVectorBuckets(vector).flatMap((bucket,table)=>[
    {table,bucket,distance:0},...Array.from({length:MEMORY_CANDIDATE_BITS},(_,bit)=>({table,bucket:bucket^(1<<bit),distance:1}))
  ]);
}
export function memoryCandidateLimit(dimension:number,requested:number):number {
  if(!Number.isSafeInteger(dimension)||dimension<1||dimension>65_536||!Number.isSafeInteger(requested)||requested<1)
    throw new Error('long_memory_index_candidate_budget_invalid');
  return Math.min(requested,MEMORY_MAX_CANDIDATES,Math.floor(MEMORY_MAX_QUERY_COORDINATES/dimension));
}
