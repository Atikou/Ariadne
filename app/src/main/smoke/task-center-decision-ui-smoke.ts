/** Injected only into the original isolated desktop smoke while its own Core
 * Decision is pending. Uses shipped UI; never settles or manufactures a Decision. */
export const TASK_CENTER_DECISION_UI_PROBE = `(async (workspaceId,sessionId,runId,decisionId,kind)=>{
  const services=window.__ariadneRendererCompositionRootV1.services;
  const filter=services.tasks.view.getSnapshot().filter;
  const wait=async probe=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const result=probe();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('task_center_exact_decision_ui_timeout:'+kind);};
  document.querySelector('.module-menu > button').click();
  (await wait(()=>[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent==='任务中心'))).click();
  await wait(()=>document.querySelector('.task-center-panel')?.checkVisibility());
  await services.tasks.setFilter({...filter,reference:{source:'run',sourceId:runId},workspaceId,sessionId,sources:['run'],states:[],includeArchived:false});
  await services.tasks.refresh(true);
  const deadline=Date.now()+30000;let row;
  while(Date.now()<deadline){row=services.tasks.view.getSnapshot().page?.rows.find(row=>row.metadata.reference.sourceId===runId&&row.decisions.some(item=>item.decisionId===decisionId));
    if(row)break;await new Promise(resolve=>setTimeout(resolve,100));await services.tasks.refresh(false);}
  if(!row)throw new Error('task_center_pending_source_missing:'+kind);
  const decision=row.decisions.find(item=>item.decisionId===decisionId);
  (await wait(()=>document.querySelector('.task-center-row[data-task-key="run:'+runId+'"]'))).click();
  (await wait(()=>document.querySelector('.task-center-detail button[data-decision-id="'+decisionId+'"]'))).click();
  const card=await wait(()=>{const target=[...document.querySelectorAll('[data-decision-id]')].find(item=>item.dataset.decisionId===decisionId&&item.checkVisibility()&&!item.closest('.task-center-panel'));
    return target&&document.activeElement===target?target:null;});
  if(!services.decisions.isPendingDecisionLoaded(decisionId,runId,decision.version)
    ||services.sessions.view.getSnapshot().selectedSessionId!==sessionId
    ||services.runs.view.getSnapshot().runs.find(item=>item.runId===runId)?.aggregateVersion!==row.metadata.version)
    throw new Error('task_center_exact_decision_authority_changed');
  const evidence={passed:true,kind,runId,decisionId,sessionId,workspaceId,expectedRunVersion:row.metadata.version,
    expectedDecisionVersion:decision.version,originalCardVisible:true,originalCardFocused:true,corePendingDetailVerified:true,readOnlyNavigation:true};
  await services.tasks.setFilter(filter);return evidence;
})`;
