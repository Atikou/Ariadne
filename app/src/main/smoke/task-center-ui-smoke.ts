import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Production directory and original navigation on retained isolated Source records. */
export async function verifyTaskCenter(window: BrowserWindow, outputRoot: string): Promise<void> {
  const originalBounds = window.getBounds();
  window.setContentSize(1000, 850);
  const capturePhase = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message.startsWith('TASK_CENTER_PHASE:')) console.info(details.message);
  };
  window.webContents.on('console-message', capturePhase);
  try {
    const evidence = await window.webContents.executeJavaScript(`(async()=>{
      const services=window.__ariadneRendererCompositionRootV1.services;
      const originalSessionId=services.sessions.view.getSnapshot().selectedSessionId;
      const originalModule=document.querySelector('.dv-active-group .dv-active-tab .module-tab > span')?.textContent??null;
      let phase='open_module';
      const diagnostic=()=>({phase,page:services.tasks.view.getSnapshot().pageNumber,rows:services.tasks.view.getSnapshot().page?.rows.length,
        loading:services.tasks.view.getSnapshot().loading,error:services.tasks.view.getSnapshot().error,
        rootVisible:document.querySelector('.task-center-panel')?.checkVisibility(),options:[...document.querySelectorAll('.module-option strong')].map(item=>item.textContent),
        active:[...document.querySelectorAll('.dv-active-tab .module-tab > span')].map(item=>item.textContent)});
      const trace=()=>console.info('TASK_CENTER_PHASE:'+JSON.stringify(diagnostic()));
      trace();
      const wait=async probe=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const value=probe();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}
        throw new Error('task_center_source_ui_timeout:'+JSON.stringify(diagnostic()));};
      const module=async name=>{document.querySelector('.module-menu > button').click();
        (await wait(()=>[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent===name))).click();};
      const match=async()=>wait(()=>{const view=services.tasks.view.getSnapshot();if(view.loading||!view.page)return null;
        const ids=[...document.querySelectorAll('.task-center-row')].map(row=>row.dataset.taskKey);
        return ids.length===view.page.rows.length&&view.page.rows.every((row,index)=>ids[index]===row.metadata.reference.source+':'+row.metadata.reference.sourceId)?view.page:null;});
      await module('任务中心');phase='visible_module';trace();await wait(()=>document.querySelector('.task-center-panel')?.checkVisibility());
      const originalPreferences=await services.preferences.load();
      const preferenceButton=()=>[...document.querySelectorAll('.task-center-header button')].find(item=>item.textContent==='提醒设置');
      let sourcePreferences=false;
      try {
        preferenceButton().click();
        await wait(()=>document.querySelector('[aria-label="任务完成提醒"]')&&!document.querySelector('.task-notification-settings').disabled);
        const before=await services.preferences.load();
        const completion=document.querySelector('[aria-label="任务完成提醒"]');
        if(completion.checked===!!before.taskNotifications?.completed)completion.click();
        await wait(()=>document.querySelector('[aria-label="任务完成提醒"]').checked===!before.taskNotifications?.completed&&!document.querySelector('.task-notification-settings').disabled);
        const persisted=await services.preferences.load();
        if(persisted.taskNotifications?.completed!==!before.taskNotifications?.completed
          ||persisted.taskNotifications?.failed!==!!before.taskNotifications?.failed)throw new Error('task_center_native_preference_not_persisted');
        sourcePreferences=true;
      } finally { await services.preferences.update(originalPreferences);if(document.querySelector('.task-notification-settings'))preferenceButton().click(); }
      phase='source_directory';trace();
      await services.tasks.refresh(true);await match();
      const buildDeadline=Date.now()+60000;
      while(services.tasks.view.getSnapshot().page.watermarks.some(mark=>mark.status==='building')){
        if(Date.now()>=buildDeadline)throw new Error('task_center_source_scan_timeout');
        await new Promise(resolve=>setTimeout(resolve,100));await services.tasks.refresh(false);await match();
      }
      const first=await match();phase='fixed_page';trace();if(first.rows.length===0||first.rows.length>128)throw new Error('task_center_source_rows_missing');
      const firstRows=JSON.stringify(first.rows),firstCursor=first.pageCursor;
      let stableFirstPage=false;
      if(first.nextCursor){await services.tasks.navigatePage('next');await match();await services.tasks.navigatePage('previous');const back=await match();
        if(back.pageCursor!==firstCursor||JSON.stringify(back.rows)!==firstRows||back.snapshotId!==first.snapshotId)throw new Error('task_center_source_first_page_changed');stableFirstPage=true;}
      const sources=new Set(),states=new Set();let terminal=null,pages=0,terminalPage=1;
      do {const current=await match();pages++;for(const row of current.rows){sources.add(row.metadata.reference.source);states.add(row.metadata.state);
          if(!terminal&&row.metadata.reference.source==='run'&&row.result==='available'&&!row.archived){terminal=row;terminalPage=services.tasks.view.getSnapshot().pageNumber;}}
        if(current.nextCursor===null)break;if(pages>=32)throw new Error('task_center_source_scan_bound');
        await services.tasks.navigatePage('next');
      }while(true);
      phase='result_navigation';trace();if(!terminal)throw new Error('task_center_committed_source_result_missing');
      while(services.tasks.view.getSnapshot().pageNumber>terminalPage){await services.tasks.navigatePage('previous');await match();}
      const key=terminal.metadata.reference.source+':'+terminal.metadata.reference.sourceId;
      (await wait(()=>[...document.querySelectorAll('.task-center-row')].find(item=>item.dataset.taskKey===key))).click();
      await wait(()=>services.tasks.view.getSnapshot().selectedKey===key&&document.querySelector('.task-center-detail'));
      const savedFilter=JSON.stringify(services.tasks.view.getSnapshot().filter),savedPage=services.tasks.view.getSnapshot().page.pageCursor;
      document.querySelector('.task-center-content').scrollTop=20;
      document.querySelector('.task-center-content').dispatchEvent(new Event('scroll'));
      const savedScroll=services.tasks.view.getSnapshot().scrollTop;
      ([...document.querySelectorAll('.task-center-detail .task-center-actions button')].find(item=>item.textContent==='查看结果')).click();
      const target=await wait(()=>{const session=services.sessions.view.getSnapshot().selectedSessionId;
        const messageWindow=services.messages.view.getSnapshot().messageWindow;
        return session===terminal.metadata.sessionId&&messageWindow?.window.kind==='around'?messageWindow:null;});
      await wait(()=>document.querySelector('.chat-panel')?.checkVisibility()||document.querySelector('.conversation-viewport')?.checkVisibility());
      const referenceId=target.window.anchorMessageId;
      const referenced=[...target.rows,...(target.anchor?[target.anchor]:[])].some(row=>row.kind==='message'&&row.metadata.messageId===referenceId);
      if(!referenced)throw new Error('task_center_original_result_window_missing');
      await wait(()=>document.getElementById('chat-node-'+referenceId)?.checkVisibility());
      const run=services.runs.view.getSnapshot().runs.find(run=>run.runId===terminal.metadata.reference.sourceId);
      if(run?.aggregateVersion!==terminal.metadata.version)throw new Error('task_center_original_core_version_changed');
      phase='return_position';trace();await module('任务中心');await wait(()=>document.querySelector('.task-center-panel')?.checkVisibility());
      if(JSON.stringify(services.tasks.view.getSnapshot().filter)!==savedFilter||services.tasks.view.getSnapshot().page.pageCursor!==savedPage
        ||services.tasks.view.getSnapshot().selectedKey!==key||document.querySelector('.task-center-content').scrollTop!==savedScroll)
        throw new Error('task_center_return_position_changed');
      const stale=await services.tasks.requestNavigation({...terminal,metadata:{...terminal.metadata,version:terminal.metadata.version+1}},'details');
      if(stale?.status!=='stale'||stale.target!==null)throw new Error('task_center_stale_source_version_accepted');
      phase='source_scope';trace();await services.tasks.refresh(false);await match();
      await services.tasks.setFilter({...services.tasks.view.getSnapshot().filter,reference:null,
        workspaceId:terminal.metadata.workspaceId,sessionId:terminal.metadata.sessionId});
      const scoped=await match();if(scoped.rows.some(row=>row.metadata.workspaceId!==terminal.metadata.workspaceId||row.metadata.sessionId!==terminal.metadata.sessionId))
        throw new Error('task_center_exact_session_filter_escaped');
      await services.tasks.setFilter({...services.tasks.view.getSnapshot().filter,workspaceId:null,sessionId:null});await match();
      return {passed:true,actualSourceDirectory:true,sourcePreferences,stableFirstPage,initialIndexedTotal:first.indexedTotal,sourceKinds:[...sources],states:[...states],
        pagesScanned:pages,complete:first.complete,watermarks:first.watermarks,exactRunId:terminal.metadata.reference.sourceId,exactSessionId:terminal.metadata.sessionId,
        expectedCoreVersion:terminal.metadata.version,resultMessageId:referenceId,originalResultWindow:true,returnFilterAndPosition:true,
        staleVersionRejected:true,exactSessionScope:true,originalSessionId,originalModule,
        source:'Actual Main/Runtime/SQLite/Projection and production DOM; retained deterministic acceptance records, no new task or Provider request.'};
    })()`, true) as { originalSessionId: string | null; originalModule: string | null };
    await writeFile(join(outputRoot, 'task-center-source-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const width of [1000, 1600]) {
      window.setContentSize(width, 850);
      const layout = await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;let previous='',stable=0,evidence;
        const deadline=Date.now()+60000;while(Date.now()<deadline){const root=document.querySelector('.task-center-panel'),box=root?.getBoundingClientRect();
          const owner=document.querySelector('.module-tab[data-module-id="tasks.center"]')?.closest('.dv-groupview')?.querySelector('.dv-content-container')?.getBoundingClientRect();
          evidence={passed:!!box&&!!owner&&root.checkVisibility()&&box.width>0&&box.height>0&&box.left>=owner.left-1&&box.right<=owner.right+1
            &&box.top>=owner.top-1&&box.bottom<=owner.bottom+1&&box.left>=0&&box.right<=innerWidth+1&&box.bottom<=innerHeight+1
            &&root.scrollWidth<=root.clientWidth&&document.querySelector('.task-center-content').scrollWidth<=document.querySelector('.task-center-content').clientWidth,
            bounds:box?.toJSON(),owner:owner?.toJSON(),windowWidth:innerWidth};
          const geometry=JSON.stringify(evidence);stable=evidence.passed?(geometry===previous?stable+1:1):0;previous=geometry;
          if(stable>=3){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {...evidence,stableSamples:stable};}
          await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('task_center_owner_layout_timeout:'+JSON.stringify(evidence));})()`, true) as { passed: boolean };
      await writeFile(join(outputRoot, `task-center-layout-${width}.json`), JSON.stringify(layout, null, 2), 'utf8');
      await writeFile(join(outputRoot, `task-center-source-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    if (evidence.originalSessionId) await window.webContents.executeJavaScript(`window.__ariadneRendererCompositionRootV1.services.sessions.select(${JSON.stringify(evidence.originalSessionId)})`, true);
    if (evidence.originalModule) await window.webContents.executeJavaScript(`(async()=>{document.querySelector('.module-menu > button').click();const deadline=Date.now()+60000;
      while(Date.now()<deadline){const option=[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent===${JSON.stringify(evidence.originalModule)});
        if(option){option.click();return;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('task_center_original_module_restore_timeout');})()`, true);
  } finally { window.webContents.removeListener('console-message', capturePhase); window.setBounds(originalBounds); }
}
