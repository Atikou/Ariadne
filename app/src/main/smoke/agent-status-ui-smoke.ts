import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Actual bounded catalogs and production navigation; no new session or Run. */
export async function verifyAgentStatusDirectory(window: BrowserWindow, outputRoot: string): Promise<void> {
  const initialBounds = window.getBounds();
  window.setContentSize(1000, 850);
  const capturePhase = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message.startsWith('AGENT_DIRECTORY_PHASE:')) console.info(details.message);
  };
  window.webContents.on('console-message', capturePhase);
  try {
    const evidence = await window.webContents.executeJavaScript(`(async()=>{
      const services=window.__ariadneRendererCompositionRootV1.services;
      let phase='open_module';
      const diagnostic=()=>{const root=document.querySelector('.agent-status-workspace');return {phase,bounds:root?.getBoundingClientRect().toJSON(),visible:root?.checkVisibility(),innerWidth,innerHeight,sourceRows:services.runs.view.getSnapshot().runDirectory?.page.rows.length,renderedRows:document.querySelectorAll('.agent-run-row').length,menuCount:document.querySelectorAll('.module-tab-menu').length,moreExpanded:document.querySelector('[aria-label="Agent 状态 更多操作"]')?.getAttribute('aria-expanded'),dialogs:document.querySelectorAll('dialog[open]').length};};
      const trace=()=>console.info('AGENT_DIRECTORY_PHASE:'+JSON.stringify(diagnostic()));
      const originalSessionId=services.sessions.view.getSnapshot().selectedSessionId;
      const originalModuleName=document.querySelector('.dv-active-group .dv-active-tab .module-tab > span')?.textContent??null;
      const wait=async probe=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const value=probe();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('agent_directory_ui_timeout:'+JSON.stringify(diagnostic()));};
      services.sessions.clearSelection();
      document.querySelector('.module-menu > button').click();
      (await wait(()=>[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent==='Agent 状态'))).click();
      await wait(()=>document.querySelector('.agent-status-workspace')&&services.runs.view.getSnapshot().runDirectory!==null);
      phase='visible_module_navigation';trace();
      await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await wait(()=>{const root=document.querySelector('.agent-status-workspace'),box=root.getBoundingClientRect();return box.width>0&&box.height>0&&box.left>=0&&box.right<=innerWidth+1&&root.checkVisibility();});
      phase='match_current_catalog';trace();
      const source=await wait(()=>{const page=services.runs.view.getSnapshot().runDirectory?.page;if(!page)return null;
        const ids=page.rows.filter(row=>row.feature==='runs').map(row=>row.dto.runId),rendered=[...document.querySelectorAll('.agent-run-row')].map(row=>row.dataset.runId);
        return ids.length===rendered.length&&ids.every((id,index)=>id===rendered[index])?page:null;});
      const rows=source.rows.filter(row=>row.feature==='runs').map(row=>row.dto);
      if(source.manifest.scope.kind!=='tasks'||rows.length===0||rows.length>128)throw new Error('agent_directory_source_scope_invalid');
      await wait(()=>document.querySelectorAll('.agent-run-row').length===rows.length);
      if(!document.querySelector('.agent-directory-description').textContent.includes('全部会话')||!document.querySelector('.agent-status-panel').textContent.includes('尚未选择会话'))throw new Error('agent_directory_empty_scope_ambiguous');
      const completed=rows.find(row=>row.status==='completed'&&row.sessionId);
      if(!completed)throw new Error('agent_directory_fixture_completed_run_missing');
      phase='open_exact_run';trace();document.querySelector('[data-run-id="'+completed.runId+'"]').click();
      await wait(()=>services.runs.view.getSnapshot().openedRunId===completed.runId);
      const opened=services.runs.view.getSnapshot().runs.find(run=>run.runId===completed.runId);
      if(services.sessions.view.getSnapshot().selectedSessionId!==completed.sessionId||opened.sessionId!==completed.sessionId||opened.status!=='completed')throw new Error('agent_directory_navigation_identity_invalid');
      await wait(()=>document.querySelector('[data-run-id="'+completed.runId+'"]')?.getAttribute('aria-current')==='true');
      if(document.querySelector('.agent-status-panel > .agent-controls'))throw new Error('agent_directory_terminal_controls_invalid');
      phase='current_session_scope';trace();document.querySelector('.agent-directory-scopes button:last-child').click();
      await wait(()=>document.querySelector('.agent-directory-description')?.textContent.includes('当前会话'));
      const current=services.runs.view.getSnapshot().sessionRunDirectory.page;
      const currentIds=current.rows.filter(row=>row.feature==='runs').map(row=>row.dto.runId);
      if(current.manifest.scope.kind!=='session'||current.manifest.scope.sessionId!==completed.sessionId||current.rows.some(row=>row.feature==='runs'&&row.dto.sessionId!==completed.sessionId))throw new Error('agent_directory_session_catalog_invalid');
      await wait(()=>document.querySelectorAll('.agent-run-row').length===currentIds.length);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {passed:true,originalSessionId,originalModuleName,runId:completed.runId,sessionId:completed.sessionId,version:opened.aggregateVersion,
        globalPageIndex:source.pageIndex,globalTotal:source.totalRows,globalRows:rows.length,sessionPageIndex:current.pageIndex,sessionTotal:current.totalRows,sessionRows:currentIds.length,
        actualSourceCatalogs:true,exactNavigationIdentity:true,terminalActionsAbsent:true,clearNoSelectionScope:true,actualVisibleModuleNavigation:true,
        source:'actual Main/Runtime/Public Projection and production DOM navigation; deterministic existing fixture records, no new session or protected objective copied to directory'};
    })()`, true) as { originalSessionId: string | null; originalModuleName: string | null };
    await writeFile(join(outputRoot, 'agent-status-directory-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
    await writeFile(join(outputRoot, 'agent-status-current-source.png'), (await window.webContents.capturePage()).toPNG());
    for (const width of [1000, 1600]) {
      window.setContentSize(width, 850);
      const layout = await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;const deadline=Date.now()+60000;let evidence,lastGeometry,stableSamples=0;
        while(Date.now()<deadline){
          const root=document.querySelector('.agent-status-workspace'),list=document.querySelector('.agent-run-list'),bounds=root.getBoundingClientRect();
          const owner=document.querySelector('.module-tab[data-module-id="agent.status"]')?.closest('.dv-groupview')?.querySelector('.dv-content-container');
          const content=owner?.getBoundingClientRect();
          const insideOwnerContent=!!content&&content.width>0&&content.height>0&&bounds.left>=content.left-1&&bounds.right<=content.right+1&&bounds.top>=content.top-1&&bounds.bottom<=content.bottom+1;
          const visible=root.checkVisibility()&&bounds.width>0&&bounds.height>0&&bounds.left>=0&&bounds.right<=innerWidth+1&&bounds.top>=0&&bounds.bottom<=innerHeight+1;
          evidence={passed:visible&&insideOwnerContent&&root.scrollWidth<=root.clientWidth&&list.scrollWidth<=list.clientWidth,visible,insideOwnerContent,
            left:bounds.left,right:bounds.right,width:bounds.width,height:bounds.height,ownerBounds:content?.toJSON(),windowWidth:innerWidth};
          const geometry=JSON.stringify(evidence);
          stableSamples=evidence.passed?(geometry===lastGeometry?stableSamples+1:1):0;lastGeometry=geometry;
          if(stableSamples>=3){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {...evidence,stableSamples};}
          await new Promise(resolve=>setTimeout(resolve,100));
        }throw new Error('agent_directory_native_owner_layout_timeout:'+JSON.stringify(evidence));})()`, true) as { passed: boolean };
      await writeFile(join(outputRoot, `agent-status-layout-${width}.json`), JSON.stringify(layout, null, 2), 'utf8');
      if (!layout.passed) throw new Error('agent_directory_native_layout_invalid');
      await writeFile(join(outputRoot, `agent-status-source-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    window.setBounds(initialBounds);
    if (evidence.originalSessionId !== null) await window.webContents.executeJavaScript(`window.__ariadneRendererCompositionRootV1.services.sessions.select(${JSON.stringify(evidence.originalSessionId)})`, true);
    if (evidence.originalModuleName !== null) await window.webContents.executeJavaScript(`(async()=>{document.querySelector('.module-menu > button').click();const deadline=Date.now()+60000;
      while(Date.now()<deadline){const option=[...document.querySelectorAll('.module-option')].find(item=>item.querySelector('strong')?.textContent===${JSON.stringify(evidence.originalModuleName)});if(option){option.click();return;}await new Promise(resolve=>setTimeout(resolve,100));}
      throw new Error('agent_directory_original_module_restore_timeout');})()`, true);
  } finally { window.webContents.removeListener('console-message', capturePhase); window.setBounds(initialBounds); }
}
