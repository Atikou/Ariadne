module.exports = async function sessionExportUi({ evaluate, wait, check, window }) {
  window.setContentSize(1000, 780);
  await evaluate("window.__uiFixture.show('chat')");
  await wait("document.querySelector('.conversation-row[data-session-id=fixture-chat-a]')");
  const open = async () => {
    await evaluate("document.querySelector('.conversation-row[data-session-id=fixture-chat-a]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:180}))");
    await wait("document.querySelector('[role=menu]')");
    await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(button=>button.textContent==='导出会话正文').click()");
    await wait("document.querySelector('[role=alertdialog]')");
  };
  const confirm = () => evaluate("document.querySelector('[role=alertdialog] .primary-button').click();document.querySelector('[role=alertdialog] .primary-button')?.click()");
  await open();
  await check('text export explains attachment references, excluded private data and restore limits', "document.activeElement.textContent==='取消'&&document.querySelector('[role=alertdialog]').textContent.includes('图像附件引用')&&document.querySelector('[role=alertdialog]').textContent.includes('图像文件、工具详情')&&document.querySelector('[role=alertdialog]').textContent.includes('不能用于恢复')");
  await evaluate("Array.from(document.querySelectorAll('[role=alertdialog] button')).find(button=>button.textContent==='取消').click()");
  await check('cancelled export confirmation does not open native selection', "window.__uiFixture.exportRequests().length===0");
  await open(); await confirm(); await wait('window.__uiFixture.exportRequests().length===1');
  await check('export dispatch preserves exact Session scope and blocks duplicate confirmation', "JSON.stringify(window.__uiFixture.exportRequests()[0])===JSON.stringify({sessionId:'fixture-chat-a',workspaceId:'ariadne-personal-assistant',scope:'public-message-text',format:'jsonl'})");
  await evaluate('window.__uiFixture.resolveExport(0)'); await wait("document.querySelector('[role=status]')?.textContent.includes('已导出 2 条')");
  await check('export success labels attachment references without claiming image bytes', "document.querySelector('[role=status]').textContent.includes('未导出图像文件')");
  await open(); await confirm(); await wait('window.__uiFixture.exportRequests().length===2');
  await evaluate('window.__uiFixture.rejectExport(1)'); await wait("document.querySelector('[role=alert]')?.textContent.includes('未能导出')");
  await check('failed export releases busy state and permits a fresh attempt', "!document.querySelector('[role=status]')");
  await open(); await confirm(); await wait('window.__uiFixture.exportRequests().length===3');
  await evaluate('window.__uiFixture.resolveExport(2,true)'); await wait("!document.querySelector('[role=status]')");
  await check('native save cancellation shows no completed export', "!document.querySelector('[role=alert]')&&!document.querySelector('[role=status]')");
};
