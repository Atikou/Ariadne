module.exports = async ({ window, wc, evaluate, wait, check }) => {
  window.setContentSize(1200, 900);
  await evaluate("window.__uiFixture.show('settings-app')");
  await wait("!!document.querySelector('.activity-bar [aria-label=\"设置\"]')");
  await evaluate("document.querySelector('.activity-bar [aria-label=\"设置\"]').click()");
  await wait("!!document.querySelector('.settings-navigation')");
  await evaluate("document.querySelector('[title=\"Agent 与模型\"]').click()");
  await wait("document.querySelectorAll('.local-model-card').length === 2");
  await evaluate("Promise.all(document.querySelector('.settings-dialog').getAnimations().map(animation => animation.finished))");
  await check('settings only exposes local capability cards and no retired benchmark controls',
    "!document.body.textContent.includes('模型质量测评') && !document.body.textContent.includes('运行质量测评') && !document.querySelector('[data-quality-model]') && !document.querySelector('.local-model-list').textContent.includes('远程模型')");
  const card = '.local-model-card:first-child';
  await check('model cards show all five capability states and disable unavailable models',
    `document.querySelector('${card} .model-capability--supported').textContent.includes('文本聊天') && document.querySelectorAll('${card} .model-capability').length === 5 && document.querySelector('${card} .model-capability--unavailable').textContent.includes('未接入') && document.querySelector('.local-model-card:last-child button').disabled`);
  for (const width of [1200, 700, 360]) {
    window.setContentSize(width, 900);
    await wait(`innerWidth === ${width}`);
    await evaluate(`document.querySelector('${card}').scrollIntoView({block:'center'})`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await check(`model cards and actions fit the settings pane at ${width}px`, `(() => {
      const pane = document.querySelector('.settings-content-scroll');
      const row = document.querySelector('${card}');
      const catalog = document.querySelector('.local-model-catalog');
      const name = row.querySelector('strong');
      const actions = row.querySelector('.local-model-card-actions');
      const r = row.getBoundingClientRect(), a = actions.getBoundingClientRect(), n = name.getBoundingClientRect();
      return Math.abs(r.width - catalog.clientWidth) <= 1
        && getComputedStyle(row.querySelector('.provider-enable span')).display !== 'none'
        && pane.scrollWidth <= pane.clientWidth && row.scrollWidth <= row.clientWidth && name.scrollWidth <= name.clientWidth
        && a.right <= r.right && a.left >= r.left && (n.right <= a.left || n.bottom <= a.top);
    })()`);
    const output = process.env.ARIADNE_SETTINGS_UI_REVIEW_DIRECTORY;
    if (output) {
      require('node:fs').mkdirSync(output, { recursive: true });
      const screenshot = await wc.capturePage();
      require('node:fs').writeFileSync(require('node:path').join(output, `settings-models-${width}.png`), screenshot.toPNG());
    }
  }
  await evaluate(`document.querySelector('${card} button').click()`);
  await wait('window.__settingsModelFixture.commands.length === 1');
  await check('recheck dispatches capability detection and locks repeated clicks',
    `window.__settingsModelFixture.commands[0].kind === 'model.qualification.run' && window.__settingsModelFixture.commands[0].modelId === 'fixture-model' && document.querySelector('${card} button').disabled`);
  await evaluate(`document.querySelector('${card} button').click(); window.__settingsModelFixture.reject()`);
  await wait("document.querySelector('.local-model-catalog [role=status]')?.textContent.includes('FIXTURE_CAPABILITY_CHECK_FAILED')");
  await check('failed capability detection releases the button for retry', `!document.querySelector('${card} button').disabled && window.__settingsModelFixture.commands.length === 1`);
  await evaluate(`document.querySelector('${card} button').click()`);
  await wait('window.__settingsModelFixture.commands.length === 2');
  await evaluate('window.__settingsModelFixture.resolve()');
  await wait(`document.querySelectorAll('${card} .model-capability--supported').length === 3`);
  await check('successful detection refreshes capability badges without any benchmark command',
    `!document.querySelector('${card} button').disabled && window.__settingsModelFixture.commands.every(command => command.kind === 'model.qualification.run')`);
  await evaluate(`document.querySelector('${card} input[type=checkbox]').click()`);
  await check('model enable switch edits a draft before saving', `!document.querySelector('${card} input[type=checkbox]').checked && window.__settingsAppFixture.saves.length === 0`);
  await evaluate("document.querySelector('.settings-floating-actions button').click()");
  await wait('window.__settingsAppFixture.saves.length === 1');
  await check('saving model selection submits the selected disabled model',
    "window.__settingsAppFixture.saves[0].operations.some(operation => operation.kind === 'localModels.replace' && operation.disabledModelIds.length === 1 && operation.disabledModelIds[0] === 'fixture-model')");
  await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()");
  await wait("!document.querySelector('.settings-dialog')");
};
