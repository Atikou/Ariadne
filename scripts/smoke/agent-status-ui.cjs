const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
module.exports = async ({window,wc,evaluate,wait,check,key,outputRoot}) => {
  window.setContentSize(360,600);
  await evaluate("window.__taskFixture.setDirectory(null);window.__uiFixture.show('agent-status')");
  await wait("document.querySelectorAll('.agent-run-row').length===2");
  await check('an unselected detail follows the directory without a growing blank gap', "document.querySelector('.agent-status-panel').getBoundingClientRect().top-document.querySelector('.agent-run-list').getBoundingClientRect().bottom<20");
  await check('all-session directory and unselected details have distinct explanations', "document.querySelector('.agent-directory-description').textContent.includes('全部会话')&&document.querySelector('.agent-status-panel').textContent.includes('尚未选择会话')&&document.querySelector('.agent-run-directory').textContent.includes('实现审查')");
  await check('public placeholders are identifiable by stable task identity and time', "document.querySelector('.agent-run-row').textContent.includes('#y-task-0')&&!!document.querySelector('.agent-run-row time')&&document.querySelector('.agent-run-heading .status-pill').textContent==='已完成'");
  await evaluate("document.querySelector('.projection-catalog-pager button:last-of-type').click();document.querySelector('.projection-catalog-pager button:last-of-type').click()");
  await wait("window.__taskFixture.directoryCalls.length===1");
  await check('directory pagination is single flight and preserves the current page while pending', "document.querySelector('.projection-catalog-pager button:last-of-type').disabled&&document.querySelectorAll('.agent-run-row').length===2");
  await evaluate('window.__taskFixture.settleDirectory()');
  await wait("document.querySelectorAll('.agent-run-row').length===1");
  await check('next page reports its real page index and pending permission status', "document.querySelector('.projection-catalog-pager').textContent.includes('第 2 页')&&document.querySelector('.agent-run-row').textContent.includes('等待')&&document.querySelector('.projection-catalog-pager button:last-of-type').disabled");
  await evaluate("document.querySelector('.agent-run-row').focus()");
  wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'char',keyCode:'\r'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await wait("window.__taskFixture.directoryCalls.some(call=>call.kind==='open')");
  await check('keyboard opens the exact task and owning session', "window.__taskFixture.directoryCalls.at(-2).kind==='select'&&window.__taskFixture.directoryCalls.at(-2).id==='fixture-b'&&window.__taskFixture.directoryCalls.at(-1).id==='directory-task-2'&&document.querySelector('.agent-run-row').getAttribute('aria-current')==='true'");
  await evaluate("document.querySelector('.agent-directory-scopes button:last-child').click()");
  await wait("document.querySelector('.agent-directory-description').textContent.includes('当前会话')");
  await check('current-session filter uses the actual session directory instead of filtering a global page', "document.querySelector('.projection-catalog-pager').textContent.includes('任务 1 项')&&document.querySelectorAll('.agent-run-row').length===1");
  await evaluate("window.__taskFixture.setDirectory('fixture-a');window.__uiFixture.show('agent-status')");
  await wait("document.querySelectorAll('.agent-run-row').length===2");
  for(const theme of ['light','dark'])for(const width of [280,360,900]){
    window.setContentSize(width,600);
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await wait(`innerWidth===${width}`);
    await check(`${theme} directory and long titles remain bounded at ${width}px`, "document.querySelector('.agent-status-workspace').scrollWidth<=innerWidth&&document.querySelector('.agent-run-list').scrollWidth<=document.querySelector('.agent-run-list').clientWidth&&document.querySelector('.agent-status-panel').getBoundingClientRect().bottom<=innerHeight+.5");
    if(outputRoot){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(outputRoot,`directory-${theme}-${width}.png`),(await wc.capturePage()).toPNG());}
  }
  await evaluate("window.__taskFixture.setDirectory(null);window.__taskFixture.holdDirectorySelection(true);document.querySelector('.agent-directory-scopes button:first-child').click()");
  await wait("document.querySelectorAll('.agent-run-row').length===2");
  await evaluate("document.querySelector('.agent-run-row').click()");
  await wait("window.__taskFixture.directoryWaits.length===1");
  await evaluate("window.__taskFixture.selectSession('fixture-b');window.__taskFixture.settleDirectory()");
  await wait("!document.querySelector('.agent-run-directory').getAttribute('aria-busy')||document.querySelector('.agent-run-directory').getAttribute('aria-busy')==='false'");
  await check('late directory selection cannot open its task into a different session', "!window.__taskFixture.directoryCalls.some(call=>call.kind==='open')&&document.querySelector('.agent-status-panel').textContent.includes('尚未打开任务')");
  await evaluate("window.__taskFixture.setDirectory(null,false,true)");
  await wait("document.querySelectorAll('.agent-run-row').length===1");
  await evaluate("document.querySelector('.agent-run-row').click()");
  await wait("document.querySelector('.agent-run-row').getAttribute('aria-current')==='true'");
  await check('a completed-only directory opens its result without cancellation controls', "document.querySelector('.agent-status-panel').textContent.includes('已完成')&&!document.querySelector('.agent-status-panel > .agent-controls')");
  await evaluate("window.__taskFixture.setDirectory(null,true)");
  await wait("document.querySelector('.agent-run-list').textContent.includes('尚无任务记录')");
  await check('empty directory is distinct from no selected session', "document.querySelector('.agent-run-list').textContent.includes('尚无任务记录')&&document.querySelector('.agent-status-panel').textContent.includes('尚未选择会话')");
};
