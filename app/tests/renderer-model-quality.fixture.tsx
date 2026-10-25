import { useState } from 'react';
import type { ModelSummary } from '@ariadne/protocol/public';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { ModelQualityControl } from '../src/renderer/src/modules/settings/ModelQualityControl';
const base={id:'fixture-ready',label:'【UI 夹具】可测评模型',location:'remote' as const,enabled:true,availability:'ready' as const,
  supportsTextChat:true,supportsAgent:true,supportsPlan:false,supportsVision:false,qualificationState:'qualified' as const};
const pending:Array<{modelId:string;resolve():void;reject(error:Error):void}>=[];
const services={models:{evaluateQuality:(modelId:string)=>new Promise<void>((resolve,reject)=>pending.push({modelId,resolve,reject}))}} as unknown as ModuleServices;
export function ModelQualityFixture({page}:{page:string}):React.JSX.Element|null {
  const [models,setModels]=useState<readonly ModelSummary[]>([base,{...base,id:'fixture-offline',label:'【UI 夹具】离线模型',availability:'unavailable'}]);
  Object.assign(window,{__qualityFixture:{count:()=>pending.length,reject:(index:number)=>pending[index]!.reject(new Error('【UI 夹具】测评失败')),
    resolve:(index:number)=>{setModels(current=>current.map(model=>model.id===pending[index]!.modelId?{...model,quality:{benchmarkId:'ariadne-text-quality-v1',
      benchmarkDigest:`sha256:${'a'.repeat(64)}`,passed:4,total:6,score:4/6,state:'expired',evaluatedAt:'2026-09-01T00:00:00.000Z',validUntil:'2026-10-01T00:00:00.000Z'}}:model));pending[index]!.resolve();}}});
  return page==='quality'?<div style={{height:'100%',overflow:'auto',padding:12}}><ModelQualityControl models={models} services={services}/></div>:null;
}
