module.exports = async ({ evaluate, wait, check, wc }) => {
  await evaluate("window.__uiFixture.show('module-opening')");
  await wait('!!window.__moduleOpeningFixture.api');
  const open = async name => {
    await evaluate("document.querySelector('.module-menu > button').click()");
    await wait("!!document.querySelector('.module-option')");
    const point = await evaluate(`(() => {const item=Array.from(document.querySelectorAll('.module-option')).find(item=>item.querySelector('strong')?.textContent===${JSON.stringify(name)});const r=item.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  await check('memory placement reference is closed in the default layout', "!window.__moduleOpeningFixture.api.getPanel('productivity.control')");
  await open('长期记忆');
  await wait("document.querySelector('.memory-panel')?.textContent.includes('当前筛选下没有记忆。')");
  await check('menu opens and activates real MemoryPanel without opening its optional reference', "window.__moduleOpeningFixture.api.activePanel.id==='memory.manage'&&!window.__moduleOpeningFixture.api.getPanel('productivity.control')");
  await open('长期记忆');
  await check('opening an existing module preserves its single panel', "window.__moduleOpeningFixture.api.panels.filter(p=>p.id==='memory.manage').length===1");
  await evaluate("(()=>{const api=window.__moduleOpeningFixture.api;api.getPanel('memory.manage').api.close();api.getPanel('agent.plan')?.api.close();})()");
  await open('目标与工作流');
  await wait("window.__moduleOpeningFixture.api.activePanel?.id==='productivity.control'");
  await evaluate("window.__moduleOpeningFixture.api.getPanel('chat.main').api.setActive()");
  await open('长期记忆');
  await wait("window.__moduleOpeningFixture.api.activePanel?.id==='memory.manage'");
  await check('an open reference still determines the target tab group', "window.__moduleOpeningFixture.api.getPanel('memory.manage').group===window.__moduleOpeningFixture.api.getPanel('productivity.control').group");
  await evaluate('window.__moduleOpeningFixture.api.clear()');
  await open('长期记忆');
  await wait("document.querySelector('.memory-panel')?.textContent.includes('当前筛选下没有记忆。')");
  await check('memory opens in an empty workspace', "window.__moduleOpeningFixture.api.panels.length===1&&window.__moduleOpeningFixture.api.activePanel.id==='memory.manage'");
};
