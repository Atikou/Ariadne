module.exports = async ({ window, wc, evaluate, wait, check, key }) => {
  await wait('!!window.__uiFixture');
  await evaluate("window.__uiFixture.show('settings-app')");
  await wait("!!document.querySelector('.activity-bar [aria-label=\"设置\"]')");
  const click = async selector => {
    const point = await evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const rect = target.getBoundingClientRect();
      if (!target.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) throw new Error('Pointer target is covered: ' + ${JSON.stringify(selector)});
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  };
  for (const width of [1900, 360]) {
    window.setContentSize(width, 900);
    await wait(`innerWidth === ${width}`);
    for (const category of ['数据管理', 'Agent 与模型', '聊天与人设', '本地语音', '归档管理', '外观与桌面']) {
      await evaluate("document.querySelector('.activity-bar [aria-label=\"设置\"]').focus(); document.querySelector('.activity-bar [aria-label=\"设置\"]').click()");
      await wait("!!document.querySelector('.settings-navigation')");
      await evaluate("Promise.all(document.querySelector('.settings-dialog').getAnimations().map(animation => animation.finished))");
      await click(`.settings-navigation-item[title="${category}"]`);
      await wait(`document.querySelector('.settings-navigation-item.is-active')?.title === '${category}'`);
      if (category === '数据管理') {
        await click('.data-management-settings .setting-block button');
        await wait("!!document.querySelector('[aria-label=\"数据占用统计\"]')");
      }
      if (category === '本地语音') {
        await click('[aria-label="选择前台语音输入模式"]');
        await wait("!!document.querySelector('.select-menu-popover')");
        await key('Escape');
        await wait("!document.querySelector('.select-menu-popover')");
        await click('.speech-settings-grid .settings-field input');
      }
      await click('[aria-label="关闭设置"]');
      await wait("!document.querySelector('.settings-dialog') && document.activeElement.getAttribute('aria-label') === '设置'");
      await check(`mouse closes ${category} at ${width}px and restores focus`, "!document.querySelector('dialog:modal')");
    }
  }
  await evaluate("window.__settingsAppFixture.failContent = true; document.querySelector('.activity-bar [aria-label=\"设置\"]').click()");
  await wait("!!document.querySelector('.settings-dialog .module-panel-error')");
  await evaluate("Promise.all(document.querySelector('.settings-dialog').getAnimations().map(animation => animation.finished))");
  await check('content errors stay inside settings and leave the shell mounted', "!!document.querySelector('.app-shell') && window.__settingsAppFixture.caughtErrors > 0");
  await click('[aria-label="关闭设置"]');
  await wait("!document.querySelector('.settings-dialog')");
  await check('close remains usable after a settings content failure', "!!document.querySelector('.activity-bar [aria-label=\"设置\"]') && !document.querySelector('dialog:modal')");
  await evaluate("window.__settingsAppFixture.failContent = false; document.querySelector('.activity-bar [aria-label=\"设置\"]').click()");
  await wait("!!document.querySelector('.settings-navigation')");
  await key('Escape');
  await wait("!document.querySelector('.settings-dialog')");
  await check('settings reopens after recovery and Escape closes it', "!!document.querySelector('.app-shell')");
};
