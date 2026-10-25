module.exports = async ({window, wc, evaluate, wait, check, key}) => {
  window.setContentSize(1100, 800);
  await evaluate("window.__uiFixture.show('chat')");
  await wait("!!document.querySelector('[aria-label=\"选择模型\"]')");
  const open = async label => {
    await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
    await wait("!!document.querySelector('[role=listbox]')");
  };
  const select = async label => {
    await evaluate(`Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent.includes(${JSON.stringify(label)})).click()`);
  };
  await check('no model is automatically selected', "document.querySelector('[aria-label=\"选择模型\"]').textContent.includes('请选择模型')");
  await open('选择模型');
  await check('model menu has only local and remote groups', "Array.from(document.querySelectorAll('[role=listbox] > [role=option]')).length === 2 && !document.body.textContent.includes('自动选择模型') && !document.body.textContent.includes('优先')");
  await select('远程 API');
  await wait("Array.from(document.querySelectorAll('[role=option]')).some(e=>e.textContent.includes('【UI 夹具】远程 API'))");
  await select('【UI 夹具】远程 API');
  await wait("document.querySelector('[aria-label=\"选择模型\"]').textContent.includes('【UI 夹具】远程 API')");
  await check('explicit remote choice is persisted with fallback disabled', "window.__uiFixture.modelSelection.requests.at(-1).operations[0].selection.modelId === 'fixture-remote' && window.__uiFixture.modelSelection.requests.at(-1).operations[0].selection.localFallbackModelId === ''");
  await open('远程不可用时');
  await check('fallback offers none and local models only', "document.querySelector('[role=listbox]').textContent.includes('不使用本地备用') && document.querySelector('[role=listbox]').textContent.includes('【UI 夹具】本地模型') && !document.querySelector('[role=listbox]').textContent.includes('【UI 夹具】远程 API')");
  await select('【UI 夹具】本地模型');
  await wait("document.querySelector('[aria-label=\"远程不可用时\"]').textContent.includes('本地模型')");
  await check('local fallback choice is persisted', "window.__uiFixture.modelSelection.requests.at(-1).operations[0].selection.localFallbackModelId === 'fixture-model'");
  for (const width of [1100, 700, 360]) {
    window.setContentSize(width, 800);
    await wait(`innerWidth === ${width}`);
    if (width === 360) {
      await evaluate("document.querySelector('[aria-label=\"收起会话列表\"]')?.click()");
      await wait("document.querySelector('.chat-panel--sidebar-hidden') !== null");
    }
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await check(`model and fallback controls fit at ${width}px`, `(() => {
      const toolbar = document.querySelector('.composer-toolbar'), controls = document.querySelector('.composer-model-controls');
      const r = toolbar.getBoundingClientRect();
      return r.right <= innerWidth && r.left >= 0 && toolbar.scrollWidth <= toolbar.clientWidth && [...controls.querySelectorAll('.select-menu-trigger')].every(element => {
        const e = element.getBoundingClientRect(); return e.width > 0 && e.left >= r.left && e.right <= r.right;
      });
    })()`);
    if (process.env.ARIADNE_MODEL_SELECTION_REVIEW_DIRECTORY) {
      const fs=require('node:fs'),path=require('node:path'),root=process.env.ARIADNE_MODEL_SELECTION_REVIEW_DIRECTORY;
      fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,`model-selection-${width}.png`),(await wc.capturePage()).toPNG());
    }
  }
  window.setContentSize(1100, 800);
  await evaluate("window.__uiFixture.modelSelection.failNext = true");
  await open('远程不可用时'); await select('不使用本地备用');
  await wait("document.body.textContent.includes('FIXTURE_SELECTION_SAVE_FAILED')");
  await check('failed save retains the previous selection', "document.querySelector('[aria-label=\"远程不可用时\"]').textContent.includes('本地模型')");
  await open('远程不可用时'); await select('不使用本地备用');
  await wait("window.__uiFixture.modelSelection.requests.at(-1).operations[0].selection.localFallbackModelId === '' && !document.querySelector('[aria-label=\"远程不可用时\"]').disabled");
  await open('选择模型'); await select('本地模型');
  await wait("Array.from(document.querySelectorAll('[role=option]')).some(e=>e.textContent.includes('【UI 夹具】本地模型'))");
  await select('【UI 夹具】本地模型');
  await wait("!document.querySelector('[aria-label=\"远程不可用时\"]')");
  await check('local choice never exposes remote fallback controls', "window.__uiFixture.modelSelection.requests.at(-1).operations[0].selection.modelId === 'fixture-model'");
};
