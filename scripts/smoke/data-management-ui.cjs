const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
module.exports = async function dataManagementUi({ evaluate, wait, check, window, reviewDirectory }) {
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
  await evaluate("window.__uiFixture.show('data-management')");
  await wait("document.querySelector('[aria-label=数据备份与恢复]')");
  await check('data UI distinguishes archival, backup and same-account scope', "document.body.textContent.includes('归档只隐藏项目')&&document.body.textContent.includes('跨机器或跨账户')&&document.body.textContent.includes('模型权重与工作区原文件不包含')");
  await click('刷新占用'); await wait("document.querySelector('[aria-label=数据占用统计]')");
  await check('usage displays logical categories and excluded recovery directories', "document.querySelector('[aria-label=数据占用统计]').textContent.includes('1 个')&&document.body.textContent.includes('逻辑大小')&&document.body.textContent.includes('保留的恢复目录')");
  await click('选择保存位置'); await click('正在创建备份…');
  await check('pending backup blocks duplicate operations', "window.__dataFixture.count()===1&&Array.from(document.querySelectorAll('.data-management-settings button')).every(button=>button.disabled)");
  await evaluate('window.__dataFixture.resolve(0)'); await wait("document.querySelector('[role=status]')?.textContent.includes('18 个文件')");
  await click('选择备份目录'); await evaluate('window.__dataFixture.reject(1)'); await wait("document.querySelector('[role=alert]')?.textContent.includes('未通过校验')");
  await check('failed validation never offers commit', "window.__dataFixture.kinds().join(',')==='backup,inspect'&&!document.querySelector('[aria-label=恢复范围预览]')");
  await click('选择备份目录'); await evaluate('window.__dataFixture.resolve(2)'); await wait("document.querySelector('[aria-label=恢复范围预览]')");
  await click('恢复并重新启动'); await wait("document.querySelector('[role=alertdialog]')");
  await check('restore confirmation focuses cancel and preserves scope explanation', "document.activeElement?.textContent==='取消'&&document.querySelector('[role=alertdialog]').textContent.includes('原目录会完整保留')");
  await click('取消'); await check('cancel does not dispatch restore', "window.__dataFixture.count()===3&&!document.querySelector('[role=alertdialog]')");
  if (reviewDirectory) {
    mkdirSync(reviewDirectory, { recursive: true });
    for (const width of [1000, 360]) {
      window.setContentSize(width, 780);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await check('restore preview fits viewport ' + width, "(()=>{const panel=document.querySelector('[aria-label=数据备份与恢复]');return panel.scrollWidth<=panel.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1})()");
      writeFileSync(join(reviewDirectory, `data-recovery-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await click('取消恢复'); await wait("!document.querySelector('[aria-label=恢复范围预览]')");
  await check('discard targets only the accepted preview ticket', "window.__dataFixture.discarded().join(',')==='00000000-0000-4000-8000-000000000003'");
  await click('选择备份目录'); await evaluate('window.__dataFixture.resolve(3)'); await wait("document.querySelector('[aria-label=恢复范围预览]')");
  await click('恢复并重新启动'); await wait("document.querySelector('[role=alertdialog]')");
  await evaluate("document.querySelector('[role=alertdialog] .primary-button').click();document.querySelector('[role=alertdialog] .primary-button')?.click()");
  await wait('window.__dataFixture.count()===5'); await check('restore dispatch is single-use while pending', "window.__dataFixture.kinds().filter(kind=>kind==='commit').length===1");
  await evaluate('window.__dataFixture.reject(4)'); await wait("document.querySelector('[role=alert]')?.textContent.includes('原目录已保留')");
  await check('failed commit releases the consumed preview UI', "!document.querySelector('[aria-label=恢复范围预览]')&&!Array.from(document.querySelectorAll('.data-management-settings button')).some(button=>button.disabled)");
  await click('选择备份目录'); await evaluate('window.__dataFixture.hide();window.__dataFixture.resolve(5)');
  await wait('window.__dataFixture.discarded().length===2');
  await check('late preview after unmount is discarded without committing', "window.__dataFixture.discarded()[1]==='00000000-0000-4000-8000-000000000006'&&window.__dataFixture.kinds().filter(kind=>kind==='commit').length===1");
  await evaluate('window.__dataFixture.show()'); await wait("document.querySelector('[aria-label=数据备份与恢复]')");
  await click('选择保存位置'); await evaluate('window.__dataFixture.reject(6)');
  await wait("document.querySelector('[role=alert]')");
  await check('failed backup releases controls without publishing success', "!document.querySelector('[role=status]')&&!Array.from(document.querySelectorAll('.data-management-settings button')).some(button=>button.disabled)");
  await click('选择备份目录'); await evaluate('window.__dataFixture.resolve(7, true)');
  await wait("!Array.from(document.querySelectorAll('.data-management-settings button')).some(button=>button.disabled)");
  await check('native selection cancellation creates no preview', "!document.querySelector('[aria-label=恢复范围预览]')&&window.__dataFixture.discarded().length===2");
};
