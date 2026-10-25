import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Shipped Settings -> command -> six real HTTPS fixture calls -> projection -> routed Run. */
export async function verifyModelQuality(window:BrowserWindow,workspaceId:string,modelId:string,outputRoot:string):Promise<void> {
  const evidence=await window.webContents.executeJavaScript(`(async()=>{
    const request=async command=>{const result=await window.ariadne.runtime.request(command);
      if(!result.ok)throw new Error('quality_smoke_request_failed:'+command.kind+':'+result.error.code);return result.value;};
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    let phase='settings';const waitFor=async predicate=>{const deadline=Date.now()+60_000;while(Date.now()<deadline){const value=await predicate();
      if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('quality_smoke_timeout:'+phase);};
    const settings=Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='设置'||button.title==='设置'||button.textContent.trim()==='设置');
    if(!settings)throw new Error('quality_smoke_settings_button_missing');settings.click();
    const category=await waitFor(()=>Array.from(document.querySelectorAll('.settings-dialog button')).find(button=>button.textContent.includes('Agent 与模型')));category.click();
    const row=await waitFor(()=>Array.from(document.querySelectorAll('[data-quality-model]')).find(row=>row.dataset.qualityModel===${JSON.stringify(modelId)}));
    const start=row.querySelector('button');if(start.disabled)throw new Error('quality_smoke_model_unavailable');start.click();
    phase='measurement';const model=await waitFor(async()=>(await snapshot()).models.find(model=>model.modelId===${JSON.stringify(modelId)}&&model.quality?.state==='current'));
    if(model.quality.passed!==6||model.quality.score!==1||model.quality.total!==6)throw new Error('quality_smoke_summary_invalid');
    await waitFor(()=>row.textContent.includes('6/6')&&!row.querySelector('button').disabled);
    document.querySelector('[aria-label=关闭设置]').click();
    const scope={contractVersion:'5.0',workspaceId:${JSON.stringify(workspaceId)},sessionId:crypto.randomUUID()};
    await request({...scope,kind:'conversation.session.create',title:'【验收夹具】质量优先路径'});
    const session=await waitFor(async()=>(await snapshot()).sessions.find(session=>session.sessionId===scope.sessionId));
    await request({...scope,kind:'conversation.message.accept',expectedSessionVersion:session.version,messageId:crypto.randomUUID(),content:'ariadne-smoke:quality_route',
      execution:{mode:'agent',routingStrategy:'quality-first'}});
    phase='quality_routed_run';const run=await waitFor(async()=>{const state=await snapshot();const answer=state.messages.find(message=>message.sessionId===scope.sessionId&&message.role==='assistant'&&message.content==='ARIADNE_SMOKE_QUALITY_ROUTE_OK');
      const run=answer&&state.runs.find(run=>run.runId===answer.runId);return run?.status==='completed'?run:null;});
    return {passed:true,modelId:${JSON.stringify(modelId)},quality:model.quality,sessionId:scope.sessionId,runId:run.runId,
      productionSettingsTriggered:true,productionProjectionDisplayed:true,qualityFirstActualAgentRunCompleted:true,
      scope:'Deterministic HTTPS fixture validates wiring; these scores do not measure a commercial or local model.'};
  })()`,true);
  await writeFile(join(outputRoot,'model-quality-execution.json'),JSON.stringify(evidence,null,2),'utf8');
}
