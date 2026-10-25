import { useEffect,useRef,useState } from 'react';
import type { ModelSummary } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-contract';

export function ModelQualityControl({models,services}:{models:readonly ModelSummary[];services:ModuleServices}):React.JSX.Element {
  const [pending,setPending]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const pendingOwner=useRef<string|null>(null);
  const evaluate=async(modelId:string)=>{
    if(pendingOwner.current!==null)return;pendingOwner.current=modelId;setPending(modelId);setError(null);
    try {await services.models.evaluateQuality(modelId);}
    catch(error){if(mounted.current)setError(error instanceof Error?error.message:'模型质量测评失败。');}
    finally {pendingOwner.current=null;if(mounted.current)setPending(null);}
  };
  return <section className="setting-block setting-block--wide model-quality-controls" aria-label="模型质量测评">
    <div><strong>模型质量测评</strong><p>质量优先按六个固定文本任务的测评成绩选择已具备所需能力的模型。测评只发送合成题目，不包含会话内容；远程测评会产生六次 API 请求。每题最多输出 512 tokens，成绩有效期为 30 天。未测评或过期的模型不参与质量优先。</p>
      <small>任务检查计算、中文格式、提取、排序、数据边界和代码推理。小样本成绩不能保证全面质量，工具和计划能力仍需另行检测；显式指定模型会优先使用你的选择。</small></div>
    {models.map(model=><div key={model.id} className="model-quality-row" data-quality-model={model.id}>
      <div><strong>{model.label}</strong><small>{model.quality
        ? `${model.quality.passed}/${model.quality.total} · ${Math.round(model.quality.score*100)}% · ${model.quality.state==='current'?'成绩有效':'成绩过期，需重新测评'} · 测评于 ${new Date(model.quality.evaluatedAt).toLocaleString()}`
        : '尚未测评'}</small></div>
      <button type="button" disabled={pending!==null||model.enabled===false||model.availability!=='ready'||!model.supportsTextChat}
        onClick={()=>void evaluate(model.id)}>{pending===model.id?'正在测评…':'运行质量测评'}</button>
    </div>)}
    {models.length===0&&<small>暂无可测评的模型。</small>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
