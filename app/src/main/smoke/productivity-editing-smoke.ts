import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Production Renderer -> Main -> actual Productivity authority; no store mocks. */
export async function verifyProductivityEditing(window: BrowserWindow, workspaceId: string, outputRoot: string, sessionId: string): Promise<void> {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const scope={contractVersion:'5.0',workspaceId:${JSON.stringify(workspaceId)},sessionId:${JSON.stringify(sessionId)}};
    const request=async command=>{const result=await window.ariadne.runtime.request(command);if(!result.ok)throw new Error('productivity_editing_request:'+command.kind+':'+result.error.code);return result.value;};
    const query=()=>request({...scope,kind:'productivity.query'});
    let phase='seed';
    const wait=async probe=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const value=await probe();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('productivity_editing_timeout:'+phase);};
    const button=(text,root='.productivity-panel')=>[...document.querySelectorAll(root+' button')].find(item=>item.textContent===text&&!item.disabled);
    const input=(selector,value)=>{const element=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
    // Reuse the enclosing gate's original isolated chat session. Do not grow
    // or weaken its deliberately bounded 32-session projection fixture.
    const unused=await query();
    if(unused.goal!==null||unused.todos.length||unused.workflows.length)throw new Error('productivity_editing_fixture_owner_not_unused');
    const created=await request({...scope,kind:'goal.put',goalId:crypto.randomUUID(),expectedVersion:null,title:'【验收夹具】原目标',phase:'implementation',status:'active',roundCap:8});
    const goal=created.goal,first=crypto.randomUUID(),second=crypto.randomUUID();
    await request({...scope,kind:'todo.snapshot.replace',goalId:goal.goalId,expectedGoalVersion:1,expectedRevision:null,items:[
      {todoId:first,title:'【验收夹具】基础待办',status:'pending',dependsOn:[]},
      {todoId:second,title:'【验收夹具】依赖待办',status:'pending',dependsOn:[first]}]});
    const services=window.__ariadneRendererCompositionRootV1.services;
    await wait(()=>services.sessions.view.getSnapshot().sessions.some(item=>item.sessionId===scope.sessionId));
    await services.sessions.select(scope.sessionId);
    document.querySelector('.module-menu > button').click();
    (await wait(()=>[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent==='目标与工作流'))).click();
    await wait(()=>document.querySelector('[data-todo-id="'+first+'"]'));
    phase='goal_refresh_conflict';
    document.querySelector('.productivity-goal > details > summary').click();
    input('[aria-label=目标]','【验收夹具】保留本地目标');
    await request({...scope,kind:'goal.put',goalId:goal.goalId,expectedVersion:1,title:'【验收夹具】后台更新目标',phase:'implementation',status:'active',roundCap:8});
    button('刷新').click();
    await wait(()=>document.querySelector('[aria-label=目标版本冲突]')?.textContent.includes('后台更新目标'));
    if(document.querySelector('[aria-label=目标]').value!=='【验收夹具】保留本地目标'||button('保存目标'))throw new Error('productivity_editing_dirty_goal_lost');
    button('保留输入，采用当前版本','[aria-label=目标版本冲突]').click();(await wait(()=>button('保存目标'))).click();
    await wait(async()=>{const current=await query();return current.goal.version===3&&current.goal.title==='【验收夹具】保留本地目标';});
    await wait(()=>!document.querySelector('.productivity-controls').disabled);
    phase='edit_todo';document.querySelector('[data-todo-id="'+second+'"] button').click();
    await wait(()=>document.querySelector('[aria-label=待办编辑标题]'));input('[aria-label=待办编辑标题]','【验收夹具】已编辑依赖待办');(await wait(()=>button('保存待办','dialog'))).click();
    const edited=await wait(async()=>{const current=await query();return current.todoRevision===2&&current.todos.find(item=>item.todoId===second)?.title==='【验收夹具】已编辑依赖待办'?current:null;});
    if(edited.todos.find(item=>item.todoId===second).dependsOn[0]!==first)throw new Error('productivity_editing_dependency_lost');
    await wait(()=>!document.querySelector('dialog')&&!document.querySelector('.productivity-controls').disabled);
    phase='reject_dependency_cycle';document.querySelector('[data-todo-id="'+first+'"] button').click();
    await wait(()=>document.querySelector('dialog .productivity-dependencies input'));document.querySelector('dialog .productivity-dependencies input').click();(await wait(()=>button('保存待办','dialog'))).click();
    await wait(()=>document.querySelector('dialog [role=alert]')?.textContent.includes('循环'));
    if(JSON.stringify(await query())!==JSON.stringify(edited))throw new Error('productivity_editing_rejected_cycle_mutated_source');
    button('取消','dialog').click();await wait(()=>!document.querySelector('dialog'));
    phase='delete_predecessor';document.querySelector('[data-todo-id="'+first+'"] button:last-child').click();
    await wait(()=>document.querySelector('[aria-label=删除依赖影响]')?.textContent.includes('已编辑依赖待办'));
    if(!document.querySelector('dialog [type=submit]').disabled)throw new Error('productivity_editing_delete_without_consent');
    document.querySelector('[aria-label=删除依赖影响] input').click();(await wait(()=>button('解除依赖并删除','dialog'))).click();
    const deleted=await wait(async()=>{const current=await query();return current.todoRevision===3&&current.todos.length===1&&current.todos[0].todoId===second&&current.todos[0].dependsOn.length===0?current:null;});
    await wait(()=>!document.querySelector('dialog')&&!document.querySelector('.productivity-controls').disabled);
    button('刷新').click();await wait(()=>!document.querySelector('[data-todo-id="'+first+'"]')&&document.querySelector('[data-todo-id="'+second+'"]')?.textContent.includes('已编辑依赖待办'));
    for(const details of document.querySelectorAll('.productivity-configuration'))details.open=false;
    await wait(()=>!document.querySelector('.productivity-task-faults button')?.disabled);
    document.querySelector('.productivity-panel').scrollTop=0;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {passed:true,workspaceId:scope.workspaceId,sessionId:scope.sessionId,goalId:goal.goalId,goalVersion:deleted.goal.version,todoRevision:deleted.todoRevision,
      realRendererDraftConflict:true,exactGoalVersionReconciled:true,actualTodoEdit:true,dependenciesPreserved:true,cycleRejectedWithoutSourceMutation:true,explicitPredecessorRemoval:true,
      source:'actual Electron Main/Runtime/SQLite; DOM interactions are automated, not physical mouse or Provider quality acceptance'};
  })()`, true);
  await writeFile(join(outputRoot, 'productivity-editing-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
  await writeFile(join(outputRoot, 'productivity-editing.png'), (await window.webContents.capturePage()).toPNG());
}
