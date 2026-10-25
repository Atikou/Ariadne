// Run: node scripts/renderer-ui-smoke.cjs
// Renders production components in an isolated Electron window with explicit fixtures.
const { join, resolve } = require('node:path');
const { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

if (!process.versions.electron) {
  const directory = mkdtempSync(join(tmpdir(), 'ariadne-ui-smoke-'));
  try {
    require('esbuild').buildSync({
      absWorkingDir: resolve(__dirname, '..'),
      entryPoints: ['app/tests/renderer-ui.fixture.tsx'],
      outfile: join(directory, 'fixture.js'),
      tsconfig: 'app/tsconfig.web.json', bundle: true, platform: 'browser',
      define: { 'process.env.NODE_ENV': process.argv.includes('--settings-only') ? '"development"' : '"production"' }
    });
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Ariadne UI fixture</title><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    copyFileSync(resolve(__dirname, '../app/src/renderer/public/popout.html'), join(directory, 'popout.html'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const timeout = process.argv.some(argument => argument.endsWith('-only')) ? 60000 : 180000;
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, directory, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, timeout });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', join(process.argv[2], 'profile'));
  app.whenReady().then(async () => {
    // Dockview permits only same-origin HTTP(S) popouts. Serve only these
    // generated, non-sensitive fixture assets on an ephemeral loopback port.
    const assets = new Map([
      ['/index.html', 'text/html'], ['/fixture.js', 'text/javascript'],
      ['/fixture.css', 'text/css'], ['/popout.html', 'text/html']
    ].map(([path, type]) => [path, { type, data: readFileSync(join(process.argv[2], path.slice(1))) }]));
    const server = require('node:http').createServer((request, response) => {
      const asset = request.method === 'GET' ? assets.get(request.url) : undefined;
      if (!asset) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
      response.end(asset.data);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.on('will-quit', () => server.close());
    const window = new BrowserWindow({ width: 1000, height: 600, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const wc = window.webContents;
    const rendererErrors = [];
    wc.on('console-message', details => {
      if (details.message?.includes('dockview')) console.log('DOCKVIEW', details.message);
      else if (details.level === 'error') { rendererErrors.push(details.message); console.error('UI fixture renderer error:', details.message); }
    });
    const evaluate = code => wc.executeJavaScript(code);
    const wait = async (expression, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const state = await evaluate("JSON.stringify({ focused: document.activeElement?.outerHTML?.slice(0, 500), dialogs: document.querySelectorAll('dialog').length, opened: window.__uiFixture?.opened, popouts: window.__workspaceFixture?.api?.getPopouts().map(item => { const d=item.window.document; const strip=d.querySelector('.dv-tabs-container');const tab=strip?.querySelector('.dv-active-tab');return { active:item.group.activePanel?.id,strip:strip?.getBoundingClientRect().toJSON(),tab:tab?.getBoundingClientRect().toJSON(),scrollLeft:strip?.scrollLeft,scrollWidth:strip?.scrollWidth,clientWidth:strip?.clientWidth,orientation:strip?.getAttribute('aria-orientation'),documentVisibility:d.visibilityState,tabOwnerMatches:tab?.ownerDocument===d }; }) })");
      throw new Error(`Timed out: ${expression}; ${state}`);
    };
    const check = async (name, expression) => {
      if (!await evaluate(expression)) {
        const state = await evaluate("JSON.stringify({ focused: document.activeElement?.outerHTML?.slice(0, 500), rootScroll: document.documentElement.scrollTop, fileScroll: document.querySelector('.file-explorer-body')?.scrollTop, fileHeight: document.querySelector('.file-explorer-body')?.clientHeight, overflow: Array.from(document.querySelectorAll('.settings-dialog *')).filter(e => e.clientWidth && e.scrollWidth > e.clientWidth).map(e => ({ tag: e.tagName, class: e.className, width: e.clientWidth, scroll: e.scrollWidth })) })");
        throw new Error(`${name}: ${state}`);
      }
      console.log(`PASS ${name}`);
    };
    const key = async (code, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    await window.loadURL(`http://127.0.0.1:${server.address().port}/index.html`);
    if (process.argv.includes('--headless')) wc.focus();
    await evaluate("window.addEventListener('error',event=>console.error('UI fixture uncaught stack:',event.error?.stack??event.message));window.addEventListener('unhandledrejection',event=>console.error('UI fixture uncaught rejection:',event.reason?.stack??String(event.reason)))");
    const dataOnly = process.argv.includes('--data-only');
    const settingsOnly = process.argv.includes('--settings-only');
    const settingsActionsOnly = process.argv.includes('--settings-actions-only');
    const settingsModelsOnly = process.argv.includes('--settings-models-only');
    const modelSelectionOnly = process.argv.includes('--model-selection-only');
    if (!dataOnly && !settingsOnly && !settingsActionsOnly && !process.argv.includes('--headless')) { window.show(); window.focus(); }
    const documentsOnly = process.argv.includes('--documents-only');
    const memoryOnly = process.argv.includes('--memory-only');
    const productivityOnly=process.argv.includes('--productivity-only');
    const agentOnly=process.argv.includes('--agent-only');
    const tasksOnly=process.argv.includes('--tasks-only');
    const moduleOpeningOnly=process.argv.includes('--module-opening-only');
    if([documentsOnly,memoryOnly,productivityOnly,agentOnly,tasksOnly,dataOnly,moduleOpeningOnly,settingsOnly,settingsActionsOnly,settingsModelsOnly,modelSelectionOnly].filter(Boolean).length>1)throw new Error('UI scopes cannot be combined');
    if(modelSelectionOnly) {
      await require('./smoke/model-selection-ui.cjs')({window,wc,evaluate,wait,check,key});
      if(rendererErrors.length)throw new Error('Model selection renderer errors: '+JSON.stringify(rendererErrors));
      window.destroy();app.exit(0);return;
    }
    if(settingsModelsOnly){
      await require('./smoke/settings-models-ui.cjs')({window,wc,evaluate,wait,check});
      if(rendererErrors.length)throw new Error('Settings model controls reported renderer errors.');
      window.destroy();app.exit(0);return;
    }
    if(settingsActionsOnly){
      wc.setBackgroundThrottling(false);
      await require('./smoke/settings-actions-ui.cjs')({window,wc,evaluate,wait,check,key});
      await require('./smoke/provider-settings-ui.cjs')({window,wc,evaluate,wait,check,key});
      if(rendererErrors.length)throw new Error('Settings actions reported renderer errors.');
      window.destroy();app.exit(0);return;
    }
    if(settingsOnly){
      wc.setBackgroundThrottling(false);
      await require('./smoke/settings-dialog-ui.cjs')({window,wc,evaluate,wait,check,key});
      if(rendererErrors.length)throw new Error('Settings UI fixture reported renderer errors.');
      console.log('Scoped settings dialog UI passed with production components and fixture services.');
      window.destroy();app.exit(0);return;
    }
    if(moduleOpeningOnly){
      await require('./smoke/module-opening-ui.cjs')({evaluate,wait,check,wc});
      if(rendererErrors.length)throw new Error('Module opening renderer errors: '+JSON.stringify(rendererErrors));
      window.destroy();app.exit(0);return;
    }
    if(dataOnly){
      await require('./smoke/data-management-ui.cjs')({evaluate,wait,check,window,reviewDirectory:process.env.ARIADNE_DATA_UI_REVIEW_DIRECTORY});
      await require('./smoke/attachment-cleanup-ui.cjs')({evaluate,wait,check,window,reviewDirectory:process.env.ARIADNE_DATA_UI_REVIEW_DIRECTORY});
      await require('./smoke/session-export-ui.cjs')({evaluate,wait,check,window});
      if(rendererErrors.length)throw new Error('Data UI fixture reported renderer errors.');
      console.log('Scoped data-management UI gate passed; fixtures do not prove original Main/Runtime backup, restore or native picker interaction.');
      app.quit(); return;
    }
    if(tasksOnly){
      const outputIndex=process.argv.indexOf('--capture-output');
      const outputRoot=outputIndex<0?null:resolve(process.argv[outputIndex+1]);
      if(outputRoot){if(require('node:fs').existsSync(outputRoot))throw new Error('UI evidence root already exists');require('node:fs').mkdirSync(outputRoot,{recursive:true});}
      await require('./smoke/task-center-ui.cjs')({window,wc,evaluate,wait,check,key,outputRoot});
      if(rendererErrors.length)throw new Error('Task center Renderer errors: '+JSON.stringify(rendererErrors));
      console.log('Scoped task center UI passed; explicit presentation fixtures do not replace Source/Runtime acceptance.');
      window.destroy();app.exit(0);return;
    }
    if(agentOnly){
      const outputIndex=process.argv.indexOf('--capture-output');
      const outputRoot=outputIndex<0?null:resolve(process.argv[outputIndex+1]);
      if(outputRoot){if(require('node:fs').existsSync(outputRoot))throw new Error('UI evidence root already exists');require('node:fs').mkdirSync(outputRoot,{recursive:true});}
      await require('./smoke/agent-status-ui.cjs')({window,wc,evaluate,wait,check,key,outputRoot});
      if(rendererErrors.length)throw new Error('Agent Renderer errors: '+JSON.stringify(rendererErrors));
      console.log('Scoped Agent UI acceptance passed; explicit presentation fixtures are separate from Source/native verification.');
      window.destroy();app.exit(0);return;
    }
    if(productivityOnly){
      const outputIndex=process.argv.indexOf('--capture-output');
      const outputRoot=outputIndex<0?null:resolve(process.argv[outputIndex+1]);
      if(outputRoot){if(require('node:fs').existsSync(outputRoot))throw new Error('UI evidence root already exists');require('node:fs').mkdirSync(outputRoot,{recursive:true});}
      const helpers={window,wc,evaluate,wait,check,key,outputRoot};
      await require('./smoke/productivity-ui-baseline.cjs')(helpers);
      await require('./smoke/productivity-ui-editing.cjs')(helpers);
      console.log('Scoped productivity UI gate passed; explicit fixtures do not replace production Source/Agent acceptance.');
      window.destroy();app.exit(0);return;
    }
    if (!documentsOnly) {
    if(!memoryOnly){
    await wait("document.querySelectorAll('.tool-call-row').length === 18");
    await check('running tools are not marked completed', "!!document.querySelector('.tool-call-row.is-running .tool-call-spinner')");
    await evaluate("document.querySelector('.tool-call-row').click()");
    await wait("window.__uiFixture.pendingCount() === 1");
    await check('detail is available while the list stays bounded', "!!document.querySelector('.tool-output-detail') && document.querySelector('.tool-call-table').scrollHeight > document.querySelector('.tool-call-table').clientHeight");
    await evaluate("window.__uiFixture.resolveDetail(0, 'page-one-', false)");
    await wait("document.querySelector('.tool-result-detail-card pre')?.textContent === 'page-one-'");
    await evaluate("document.querySelector('.tool-result-detail-card > button').click()");
    await wait("window.__uiFixture.pendingCount() === 2");
    await evaluate("window.__uiFixture.resolveDetail(1, 'page-two')");
    await wait("document.querySelector('.tool-result-detail-card pre')?.textContent === 'page-one-page-two'");
    await check('tool pagination appends without losing the first page', "!document.querySelector('.tool-result-detail-card > button')");
    window.setContentSize(360, 500);
    await wait("innerWidth === 360 && getComputedStyle(document.querySelector('.tool-call-table')).display === 'none'");
    await check('narrow tool detail has no horizontal overflow', "document.querySelector('.tool-detail-scroll').scrollWidth <= document.querySelector('.tool-detail-scroll').clientWidth");
    await evaluate("document.querySelector('.tool-detail-back').click()");
    await wait("!document.querySelector('.tool-output-detail') && document.activeElement.classList.contains('tool-call-row')");
    await check('back returns focus to the original tool row', "document.activeElement.classList.contains('tool-call-row')");
    await evaluate("document.querySelector('.tool-call-row').click()");
    await wait("window.__uiFixture.pendingCount() === 3");
    await evaluate("window.__uiFixture.switchSession('session-b')");
    await wait("document.querySelectorAll('.tool-call-row').length === 0");
    await evaluate("window.__uiFixture.resolveDetail(2, 'STALE-RESULT')");
    await check('late tool result cannot cross session boundaries', "!document.body.textContent.includes('STALE-RESULT') && !document.querySelector('.tool-output-detail')");

    await evaluate("window.__uiFixture.show('files')");
    await wait("document.querySelectorAll('[role=treeitem]').length === 31");
    await evaluate("document.querySelector('[role=treeitem]').focus()");
    await key('Right');
    await wait("document.querySelector('[role=treeitem]').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('[role=treeitem]').length === 32");
    await key('Right');
    await check('file tree right arrow enters the folder', "document.activeElement.title === 'src/index.ts'");
    await key('Left');
    await check('file tree left arrow returns to the parent', "document.activeElement.title === 'src'");
    await key('Left');
    await key('End');
    await check('file tree scrolls only its own viewport', "document.activeElement.title === 'file-29.ts' && document.querySelector('.file-explorer-body').scrollTop > 0 && document.documentElement.scrollTop === 0");
    await check('file tree has no horizontal overflow at 360px', "document.querySelector('.file-explorer-body').scrollWidth <= document.querySelector('.file-explorer-body').clientWidth");

    await evaluate("window.__uiFixture.show('logs')");
    await wait("!!document.querySelector('.logs-controls')");
    await check('log toolbar fits a narrow panel', "document.querySelector('.logs-panel').scrollWidth <= innerWidth");
    window.setContentSize(360, 230);
    await wait("innerHeight === 230");
    await check('empty logs do not create a spurious scrollbar', "document.querySelector('.logs-list').scrollHeight <= document.querySelector('.logs-list').clientHeight");

    window.setContentSize(1000, 600);
    await evaluate("window.__uiFixture.show('palette')");
    await wait("!!document.querySelector('#fixture-opener')");
    await evaluate("document.querySelector('#fixture-opener').focus(); document.querySelector('#fixture-opener').click()");
    await wait("document.activeElement?.getAttribute('role') === 'combobox'");
    await key('Up');
    await check('command navigation wraps and scrolls within results', "document.querySelector('[aria-selected=true]')?.textContent.includes('测试模块 17') && document.querySelector('.command-results').scrollTop > 0 && document.documentElement.scrollTop === 0");
    await key('Enter');
    await wait("!document.querySelector('dialog')");
    await check('Enter activates exactly the selected command', "window.__uiFixture.opened.join(',') === 'module-17'");
    await evaluate("document.querySelector('#fixture-opener').focus(); document.querySelector('#fixture-opener').click()");
    await wait("document.activeElement?.getAttribute('role') === 'combobox'");
    await key('Escape');
    await wait("!document.querySelector('dialog') && document.activeElement.id === 'fixture-opener'");
    await check('Escape restores focus to the command opener', "document.activeElement.id === 'fixture-opener'");
    await evaluate("window.__uiFixture.show('composer-controls')");
    await wait("document.querySelectorAll('.composer-actions button').length === 4");
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      await check(`${theme}: microphone, send, stop and pending stop share 29px geometry`, `Array.from(document.querySelectorAll('.composer-actions button')).every(button => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width === 29 && rect.height === 29 && style.boxShadow === 'none' && style.transform === 'none'
          && style.borderRadius === getComputedStyle(document.querySelector('.composer-mic-button')).borderRadius;
      })`);
    }
    wc.setZoomFactor(1.5);
    await check('150% zoom preserves equal composer-control sizes', "Array.from(document.querySelectorAll('.composer-actions button')).every(button => button.getBoundingClientRect().width === 29 && button.getBoundingClientRect().height === 29)");
    wc.setZoomFactor(1);
    await evaluate("window.__uiFixture.show('dialogs')");
    await wait("!!document.querySelector('#open-confirm')");
    await evaluate("document.querySelector('#open-confirm').focus(); document.querySelector('#open-confirm').click()");
    await wait("document.activeElement?.textContent === '取消'");
    await check('confirmation is natively modal and starts on the safe action', "document.querySelector('dialog[role=alertdialog]').matches(':modal') && document.activeElement.textContent === '取消'");
    await evaluate("document.querySelector('#background-action').focus()");
    await check('background cannot steal focus while confirmation is open', "document.activeElement.textContent === '取消'");
    await key('Tab', ['shift']);
    await check('Shift+Tab wraps within the confirmation', "document.activeElement.textContent === '确认'");
    await key('Tab');
    await check('Tab wraps back to cancel', "document.activeElement.textContent === '取消'");
    await key('Escape');
    await wait("!document.querySelector('dialog') && document.activeElement.id === 'open-confirm'");
    await check('confirmation Escape restores its opener', "document.activeElement.id === 'open-confirm'");
    await evaluate("document.querySelector('#open-prompt').focus(); document.querySelector('#open-prompt').click()");
    await wait("document.activeElement?.tagName === 'INPUT'");
    await check('rename selects the initial text', "document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length");
    await wc.insertText('   ');
    await wait("document.querySelector('.action-dialog [type=submit]').disabled");
    await check('blank rename cannot be submitted', "document.querySelector('.action-dialog [type=submit]').disabled");
    await key('A', ['control']);
    await wc.insertText('  新名称  ');
    await wait("document.querySelector('.action-dialog input')?.value === '  新名称  ' && !document.querySelector('.action-dialog [type=submit]').disabled");
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait("!document.querySelector('dialog') && document.activeElement.id === 'open-prompt'");
    await check('rename Enter submits trimmed text once', "window.__uiFixture.opened.filter(value => value === '新名称').length === 1");
    await evaluate("document.querySelector('#open-prompt').click()");
    await wait("document.activeElement?.value === '新名称'");
    await check('reopening rename selects the latest name', "document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 3");
    await key('Escape');
    await wait("!document.querySelector('dialog')");

    await evaluate("document.querySelector('#open-select').focus(); document.querySelector('#open-select').click()");
    await wait("document.activeElement.id === 'before-select'");
    await evaluate("document.querySelector('.select-menu-trigger').click()");
    await wait("document.activeElement?.getAttribute('role') === 'option'");
    await check('dropdown belongs to the native modal top layer', "document.querySelector('.select-menu-popover').closest('dialog')?.matches(':modal')");
    await key('Escape');
    await wait("!document.querySelector('.select-menu-popover') && document.activeElement.classList.contains('select-menu-trigger')");
    await check('first Escape dismisses only the dropdown', "document.querySelectorAll('dialog:modal').length === 1");
    await key('Down');
    await wait("document.activeElement?.getAttribute('role') === 'option'");
    await key('End');
    await key('Right');
    await wait("document.activeElement?.closest('.select-menu-submenu') && document.activeElement.textContent === '子选项'");
    await key('Down');
    await check('submenu Down moves actual focus, not only the stored index', "document.activeElement.textContent === '子选项 2'");
    await key('End');
    await check('submenu End focuses its last option', "document.activeElement.textContent === '子选项 3'");
    await key('Left');
    await wait("!document.querySelector('.select-menu-submenu') && document.activeElement.textContent === '子菜单'");
    await check('submenu Left returns focus to the owning option', "!!document.querySelector('.select-menu-popover')");
    await key('Escape');
    await wait("!document.querySelector('.select-menu-popover')");
    await key('Down');
    await wait("document.activeElement?.getAttribute('role') === 'option'");
    await key('Tab');
    await check('Tab from dropdown moves to the next form control', "document.activeElement.id === 'after-select' && !document.querySelector('.select-menu-popover')");
    await key('Tab', ['shift']);
    await key('Down');
    await wait("document.activeElement?.getAttribute('role') === 'option'");
    await key('Tab', ['shift']);
    await check('Shift+Tab from dropdown moves to the previous form control', "document.activeElement.id === 'before-select'");
    await evaluate("document.querySelector('#after-select').focus(); document.querySelector('#after-select').click()");
    await wait("document.querySelectorAll('dialog:modal').length === 2");
    await key('Escape');
    await wait("document.querySelectorAll('dialog:modal').length === 1 && document.activeElement.id === 'after-select'");
    await check('nested confirmation returns focus to the parent dialog', "document.activeElement.id === 'after-select'");
    await key('Escape');
    await wait("!document.querySelector('dialog') && document.activeElement.id === 'open-select'");

    await evaluate("document.querySelector('#open-settings').focus(); document.querySelector('#open-settings').click()");
    await wait("!!document.querySelector('.settings-panel input')");
    await check('settings starts at its close button', "document.activeElement.getAttribute('aria-label') === '关闭设置'");
    for (const width of [1000, 720, 360]) {
      window.setContentSize(width, 500);
      await wait(`innerWidth === ${width}`);
      for (const category of ['Agent 与模型', '聊天与人设', '本地语音', '归档管理', '外观与桌面']) {
        await evaluate(`document.querySelector('.settings-navigation-item[title="${category}"]').click()`);
        await wait(`document.querySelector('.settings-navigation-item.is-active')?.title === '${category}'`);
        await check(`settings ${category} fits at ${width}px`, "['.settings-dialog', '.settings-panel', '.settings-content-scroll'].every(selector => { const element = document.querySelector(selector); return element.scrollWidth <= element.clientWidth; }) && document.querySelector('.settings-dialog').getBoundingClientRect().bottom <= innerHeight");
      }
    }
    await evaluate("document.querySelector('.settings-navigation-item[title=\"本地语音\"]').click()");
    await wait("!!document.querySelector('.settings-select-menu')");
    await evaluate("document.querySelector('.settings-select-menu .select-menu-trigger').click()");
    await wait("document.activeElement?.getAttribute('role') === 'option'");
    await key('Escape');
    await wait("!document.querySelector('.select-menu-popover')");
    await check('settings dropdown Escape does not discard the settings page', "!!document.querySelector('.settings-dialog') && document.activeElement.classList.contains('select-menu-trigger')");
    await key('Escape');
    await wait("!document.querySelector('dialog') && document.activeElement.id === 'open-settings'");
    await check('settings Escape restores its opener', "document.activeElement.id === 'open-settings'");
    window.setContentSize(1000, 700);
    await evaluate("window.__uiFixture.show('chat')");
    await wait("!!document.querySelector('.chat-conversation--empty .composer')");
    for (const height of [280, 400, 700, 1000]) {
      window.setContentSize(1000, height);
      await wait(`innerHeight === ${height}`);
      await check(`empty chat composer stays bottom-centered at ${height}px height`, "(() => { const composer = document.querySelector('.composer').getBoundingClientRect(); const panel = document.querySelector('.chat-conversation').getBoundingClientRect(); return Math.abs((composer.left + composer.right) / 2 - (panel.left + panel.right) / 2) < 1 && Math.abs(panel.bottom - composer.bottom - 20) < 1; })()");
    }
    await evaluate("window.__composerBeforeHistory = document.querySelector('.composer').getBoundingClientRect().top; window.__uiFixture.setChatHistory(30)");
    await wait("document.querySelectorAll('[data-conversation-node]').length === 30");
    await check('first message does not move the composer', "document.querySelector('.composer').getBoundingClientRect().top === window.__composerBeforeHistory");
    await check('long history scrolls independently above the composer', "document.querySelector('.message-viewport').scrollHeight > document.querySelector('.message-viewport').clientHeight && document.querySelector('.message-stage').getBoundingClientRect().bottom <= document.querySelector('.composer').getBoundingClientRect().top");
    await evaluate("document.querySelector('[aria-label=\"收起会话列表\"]').click()");
    window.setContentSize(360, 500);
    await wait("innerWidth === 360 && document.querySelector('.chat-panel--sidebar-hidden')");
    await check('narrow chat composer remains centered and visible', "(() => { const composer = document.querySelector('.composer').getBoundingClientRect(); const panel = document.querySelector('.chat-conversation').getBoundingClientRect(); return composer.left >= panel.left && composer.right <= panel.right && Math.abs(panel.bottom - composer.bottom - 20) < 1; })()");
    await evaluate("document.querySelector('.composer textarea').focus()");
    await wc.insertText(Array.from({ length: 20 }, (_, i) => `多行草稿 ${i}`).join('\n'));
    await wait("document.querySelector('.composer textarea').scrollHeight > document.querySelector('.composer textarea').clientHeight");
    await check('multiline draft grows upward without moving the bottom edge', "Math.abs(document.querySelector('.chat-conversation').getBoundingClientRect().bottom - document.querySelector('.composer').getBoundingClientRect().bottom - 20) < 1 && document.querySelector('.composer').getBoundingClientRect().top >= document.querySelector('.chat-header').getBoundingClientRect().bottom");
    await evaluate("window.__uiFixture.selectChatSession('fixture-chat-a')");
    await wait("document.querySelector('.composer-image-draft [role=alert]')?.textContent.includes('图片读取失败')");
    await check('image read failure retains the owned reference and exposes a retry', "window.__uiFixture.chatDrafts.draft('fixture-chat-a').editing.attachments.length === 1 && document.querySelector('.composer-image-draft [role=alert] button').textContent === '重试读取'");
    await evaluate("window.__uiFixture.chatDrafts.allowImageRead(); document.querySelector('.composer-image-draft [role=alert] button').click()");
    await wait("document.querySelector('.composer-image-draft img')?.naturalWidth === 1");
    await check('explicit retry loads the same private image instead of duplicating attachments', "window.__uiFixture.chatDrafts.draft('fixture-chat-a').editing.attachments.length === 1 && !document.querySelector('.composer-image-draft [role=alert]')");
    await evaluate("window.__uiFixture.chatDrafts.prepareRecovery('fixture-chat-a')");
    await wait("document.querySelector('.composer textarea')?.value === 'B 当前输入' && document.querySelector('.composer-draft-recovery button')?.textContent === '恢复到输入框'");
    await evaluate("window.__uiFixture.selectChatSession('fixture-chat-b')");
    await wait("document.querySelector('.composer textarea')?.value === '' && !document.querySelector('.composer-draft-recovery') && !document.querySelector('.composer-image-draft')");
    await check('failed A and its image remain owned by A after switching to B', "window.__uiFixture.chatDrafts.draft('fixture-chat-a').submissions[0].text === 'A 保留内容' && window.__uiFixture.chatDrafts.draft('fixture-chat-b').editing.attachments.length === 0");
    await evaluate("window.__uiFixture.selectChatSession('fixture-chat-a')");
    await wait("document.querySelector('.composer textarea')?.value === 'B 当前输入'");
    await evaluate("document.querySelector('.composer-draft-recovery button').click()");
    await wait("document.querySelector('.composer textarea')?.value === 'B 当前输入\\nA 保留内容' && document.querySelector('.composer-image-draft img')?.naturalWidth === 1");
    await check('recovery UI preserves B while merging failed A and its owned image', "!document.querySelector('.composer-draft-recovery') && window.__uiFixture.chatDrafts.draft('fixture-chat-a').editing.attachments.length === 1");
    if (process.argv.includes('--chat-drafts-only')) {
      console.log('Scoped chat draft UI gate passed; other module gates were not run.');
      window.destroy(); app.exit(0); return;
    }
    window.setContentSize(280, 500);
    await evaluate("window.__uiFixture.show('agent-status')");
    await wait("!!document.querySelector('.agent-status-panel > .agent-controls button')");
    await check('task status keeps header and actions outside its scroll area', "document.querySelector('.agent-status-body').scrollHeight > document.querySelector('.agent-status-body').clientHeight && document.querySelector('.agent-status-panel').scrollWidth <= innerWidth && document.querySelector('.agent-status-panel > .agent-controls').getBoundingClientRect().bottom <= innerHeight + .5");
    await evaluate("document.querySelector('.agent-status-panel > .agent-controls button').click(); document.querySelector('.agent-status-panel > .agent-controls button').click()");
    await wait("document.querySelector('.agent-status-panel > .agent-controls button').disabled");
    await check('projection-origin task control submits once and disables duplicates', "window.__taskFixture.actions.length === 1 && window.__taskFixture.actions[0].kind === 'cancel'");
    await evaluate("window.__taskFixture.settleAction(0, true)");
    await wait("document.querySelector('.agent-action-feedback[role=alert]')?.textContent.includes('提交失败')");
    await check('failed task action is visible and can be retried', "!document.querySelector('.agent-status-panel > .agent-controls button').disabled");
    await evaluate("window.__taskFixture.setRun({runId:'second-task',status:'waiting_budget'})");
    await wait("document.querySelector('.agent-controls button')?.textContent.includes('按建议预算继续')");
    await check('changing tasks clears old action errors', "!document.querySelector('.agent-action-feedback[role=alert]')");
    await evaluate("window.__taskFixture.setRun({status:'completed'})");
    await wait("!document.querySelector('.agent-controls')");
    await check('completed task exposes no cancellation action', "!document.querySelector('.agent-controls')");

    await evaluate("window.__taskFixture.setRun({status:'interrupted',cancellationPending:true})");
    await wait("document.querySelector('.agent-status-panel').textContent.includes('已收到取消请求')");
    await check('uncertain cancelled tool offers explicit resolution and cannot restart', "!Array.from(document.querySelectorAll('.agent-status-panel button')).some(button => button.textContent.includes('从检查点继续')) && Array.from(document.querySelectorAll('.agent-status-panel button')).some(button => button.textContent.includes('确认结束任务')) && document.querySelector('.agent-status-panel').textContent.includes('结果仍不确定')");
    await evaluate("window.__taskFixture.setRun({status:'completed'})");

    await evaluate("window.__uiFixture.show('agent-plan')");
    await wait("document.querySelectorAll('.plan-handoff-card').length === 1");
    await check('plan panel never mixes another session into the selected conversation', "!document.body.textContent.includes('OTHER-SESSION-PLAN') && document.querySelector('.agent-plan-body').scrollWidth <= document.querySelector('.agent-plan-body').clientWidth");
    await evaluate("document.querySelector('.plan-actions .primary-button').click(); document.querySelector('.plan-actions .primary-button').click()");
    await wait("document.querySelector('.plan-actions .primary-button').disabled");
    await check('plan submission disables both decisions and prevents duplicate approval', "window.__taskFixture.actions.length === 2 && Array.from(document.querySelectorAll('.plan-actions button')).every(button => button.disabled)");
    await evaluate("window.__taskFixture.settleAction(1,true)");
    await wait("document.querySelector('.plan-notice[role=alert]')?.textContent.includes('提交失败')");
    await check('plan failure remains visible without pretending approval succeeded', "!document.querySelector('.plan-actions .primary-button').disabled && document.querySelector('.plan-handoff-card .status-pill').textContent === '待确认'");
    await evaluate("window.__taskFixture.setPlan({status:'approved',projectionVersion:2,actionAvailable:false})");
    await wait("!document.querySelector('.plan-actions')");
    await check('approved plan shows a final state instead of an unavailable-channel warning', "document.querySelector('.plan-handoff-card .status-pill').textContent === '已批准' && !document.querySelector('.plan-notice')");

    window.setContentSize(320, 400);
    await evaluate("window.__uiFixture.show('terminal')");
    await wait("window.__taskFixture.terminals.length === 1 && !!document.querySelector('.terminal-recovery')");
    await check('starting terminal disables repeated restarts', "document.querySelector('.terminal-restart').disabled");
    await evaluate("window.__taskFixture.settleTerminal(0)");
    await wait("!!document.querySelector('.terminal-status--running')");
    await check('terminal retains usable content space beneath its recovery banner', "document.querySelector('.terminal-session-stack').clientHeight > 100 && document.querySelector('.terminal-panel').scrollWidth <= innerWidth");
    await evaluate("document.querySelector('.terminal-restart').focus(); document.querySelector('.terminal-restart').click()");
    await wait("!!document.querySelector('dialog:modal')");
    await check('restarting a live terminal requires explicit confirmation', "window.__taskFixture.terminals.length === 1 && window.__taskFixture.closed.length === 0");
    await key('Escape');
    await wait("!document.querySelector('dialog')");
    await check('dismissing restart preserves the running terminal', "window.__taskFixture.closed.length === 0");
    await evaluate("document.querySelector('.terminal-restart').click()");
    await wait("!!document.querySelector('dialog:modal')");
    await evaluate("document.querySelector('.action-dialog .primary-button').click()");
    await wait("window.__taskFixture.terminals.length === 2");
    await check('confirmed restart creates exactly one replacement terminal', "window.__taskFixture.closed.length === 1");
    await evaluate("window.__taskFixture.settleTerminal(1,true)");
    await wait("!!document.querySelector('.terminal-status--error')");
    await check('failed terminal can be restarted again', "!document.querySelector('.terminal-restart').disabled");
    if (process.argv.includes('--capture')) {
      const reviewDirectory = mkdtempSync(join(tmpdir(), 'ariadne-ui-review-'));
      window.setContentSize(360, 640);
      await wait('innerWidth === 360');
      writeFileSync(join(reviewDirectory, 'terminal.png'), (await wc.capturePage()).toPNG());
      await evaluate("window.__taskFixture.setRun({status:'running'}); window.__uiFixture.show('agent-status')");
      await wait("!!document.querySelector('.agent-status-panel')");
      writeFileSync(join(reviewDirectory, 'agent-status.png'), (await wc.capturePage()).toPNG());
      await evaluate("window.__taskFixture.setPlan({status:'pending',actionAvailable:true}); window.__uiFixture.show('agent-plan')");
      await wait("!!document.querySelector('.agent-plan-panel')");
      writeFileSync(join(reviewDirectory, 'agent-plan.png'), (await wc.capturePage()).toPNG());
      console.log(`UI_REVIEW_ARTIFACTS ${reviewDirectory}`);
    }
    const productivityReviewDirectory = process.argv.includes('--capture') ? mkdtempSync(join(tmpdir(), 'ariadne-productivity-review-')) : null;
    window.setContentSize(360, 500);
    await evaluate("window.__uiFixture.show('productivity')");
    await wait("window.__productivityFixture.queries.length === 1");
    await check('productivity writes are disabled until the selected session loads', "document.querySelector('.productivity-controls').disabled");
    await evaluate("window.__productivityFixture.selectSession('productivity-b')");
    await wait("window.__productivityFixture.queries.length === 2");
    await evaluate("window.__productivityFixture.settleQuery(1, 'GOAL-B')");
    await wait("document.querySelector('input[aria-label=目标]')?.value === 'GOAL-B'");
    await evaluate("window.__productivityFixture.settleQuery(0, 'STALE-A')");
    await check('a late productivity response cannot replace another session', "document.querySelector('input[aria-label=目标]').value === 'GOAL-B' && !document.body.textContent.includes('STALE-A')");
    await evaluate("const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存目标'); button.click(); button.click()");
    await wait("window.__productivityFixture.actions.length === 1 && document.querySelector('.productivity-controls').disabled");
    await check('productivity prevents duplicate submissions and binds the current owner', "window.__productivityFixture.actions[0].input.sessionId === 'productivity-b' && window.__productivityFixture.actions[0].input.workspaceId === 'workspace-b'");
    await evaluate("window.__productivityFixture.settleAction(0)");
    await wait("window.__productivityFixture.queries.length === 3");
    await evaluate("window.__productivityFixture.settleQuery(2, 'REFRESH-FAILED', true)");
    await wait("document.querySelector('[role=alert]')?.textContent.includes('REFRESH-FAILED') && !document.querySelector('.productivity-controls').disabled");
    await check('a post-command refresh rejection is caught and shown', "window.__productivityFixture.unhandled.length === 0");
    await evaluate("const refresh = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '刷新'); refresh.click(); refresh.click()");
    await wait("window.__productivityFixture.queries.length === 5");
    await evaluate("window.__productivityFixture.settleQuery(4, 'FRESH-B')");
    await wait("document.querySelector('input[aria-label=目标]')?.value === 'FRESH-B'");
    await evaluate("window.__productivityFixture.settleQuery(3, 'STALE-FAILURE', true)");
    await check('superseded refresh errors cannot overwrite current productivity state', "!document.body.textContent.includes('STALE-FAILURE') && document.querySelector('input[aria-label=目标]').value === 'FRESH-B'");
    await evaluate("const input = document.querySelector('input[aria-label=调度任务]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'FIXTURE-TASK'); input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('button[aria-label=调度类型]').click()");
    await wait("!!Array.from(document.querySelectorAll('[role=option]')).find(b=>b.textContent.includes('固定间隔'))");
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(b=>b.textContent.includes('固定间隔')).click()");
    await wait("document.querySelector('button[aria-label=调度类型]').textContent.includes('固定间隔')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === '创建调度').click()");
    await wait("window.__productivityFixture.actions.length === 2");
    await check('interval UI sends the actual protocol timing contract', "window.__productivityFixture.actions[1].input.timing.kind === 'interval' && window.__productivityFixture.actions[1].input.timing.intervalMs === 3600000");
    await evaluate("window.__productivityFixture.settleAction(1,true)");
    await wait("!document.querySelector('.productivity-controls').disabled");
    await evaluate("document.querySelector('button[aria-label=调度类型]').click()");
    await wait("!!Array.from(document.querySelectorAll('[role=option]')).find(b=>b.textContent.includes('Cron'))");
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(b=>b.textContent.includes('Cron')).click()");
    await wait("!!document.querySelector('input[aria-label=调度时区]')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === '创建调度').click()");
    await wait("window.__productivityFixture.actions.length === 3");
    await check('Cron UI sends its expression and explicit timezone', "window.__productivityFixture.actions[2].input.timing.kind === 'cron' && window.__productivityFixture.actions[2].input.timing.expression === '0 9 * * *' && !!window.__productivityFixture.actions[2].input.timing.timezone");
    await evaluate("window.__productivityFixture.settleAction(2,true)");
    await wait("!document.querySelector('.productivity-controls').disabled");
    await check('productivity remains within a narrow panel', "document.querySelector('.productivity-panel').scrollWidth <= innerWidth");
    if (productivityReviewDirectory) writeFileSync(join(productivityReviewDirectory, 'productivity.png'), (await wc.capturePage()).toPNG());
    await evaluate("window.__uiFixture.show('permissions')");
    await wait("!!document.querySelector('.permission-actions')");
    await evaluate("const allow = document.querySelector('.permission-actions .rewrite-send-button'); allow.click(); allow.click()");
    await wait("window.__productivityFixture.actions.length === 4 && Array.from(document.querySelectorAll('.permission-actions button')).every(b=>b.disabled)");
    await check('permission actions block duplicate or conflicting decisions while pending', "window.__productivityFixture.actions[3].kind === 'allow_once' && document.querySelector('[role=status]').textContent.includes('正在提交权限决定')");
    await evaluate("window.__productivityFixture.settleAction(3,true)");
    await wait("document.querySelector('[role=alert]')?.textContent.includes('提交被拒绝') && !document.querySelector('.permission-actions button').disabled");
    await check('permission rejection has visible feedback and no unhandled promise', "window.__productivityFixture.unhandled.length === 0");
    if (productivityReviewDirectory) {
      writeFileSync(join(productivityReviewDirectory, 'permission-failure.png'), (await wc.capturePage()).toPNG());
      console.log(`PRODUCTIVITY_REVIEW_ARTIFACTS ${productivityReviewDirectory}`);
    }
    await evaluate("document.querySelector('.permission-actions .rewrite-cancel-button').click()");
    await wait("window.__productivityFixture.actions.length === 5");
    await evaluate("window.__productivityFixture.settleAction(4)");
    await wait("!document.querySelector('[role=alert]') && !document.querySelector('[role=status]')");
    await check('permission retry clears the prior error after successful settlement', "window.__productivityFixture.actions[4].kind === 'deny'");
    await evaluate("window.__uiFixture.show('productivity')");
    await wait("window.__productivityFixture.queries.length === 6");
    await evaluate("window.__productivityFixture.settleQuery(5, 'HISTORY-B')");
    await wait("document.querySelector('[data-occurrence-id=productivity-b-retry]') && !document.querySelector('.schedule-occurrence-history button').disabled");
    await check('history shows failure and attempts and blocks retry for paused schedules', "document.querySelector('[data-occurrence-id=productivity-b-retry]').textContent.includes('提交失败') && document.querySelector('[data-occurrence-id=productivity-b-retry]').textContent.includes('已尝试 8 次') && document.querySelector('[data-occurrence-id=productivity-b-paused] button').disabled");
    await evaluate("Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='较早记录').click()");
    await wait("document.querySelector('[data-occurrence-id=productivity-b-older]') && !document.querySelector('.schedule-occurrence-history button').disabled");
    await check('history pagination carries the scoped server cursor and separates submission from execution', "window.__productivityFixture.historyQueries.at(-1).before.occurrenceId === 'productivity-b-paused' && document.querySelector('[data-occurrence-id=productivity-b-older]').textContent.includes('已提交到会话') && !document.querySelector('[data-occurrence-id=productivity-b-older] button')");
    await evaluate("Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='较新记录').click()");
    await wait("document.querySelector('[data-occurrence-id=productivity-b-retry] button:not(:disabled)')");
    await evaluate("const retry=document.querySelector('[data-occurrence-id=productivity-b-retry] button');retry.click();retry.click()");
    await wait("window.__productivityFixture.actions.length === 6 && document.querySelector('[data-occurrence-id=productivity-b-retry] button').disabled");
    await check('manual retry is single flight and uses the occurrence CAS without resetting attempts', "window.__productivityFixture.actions[5].kind === 'retryOccurrence' && window.__productivityFixture.actions[5].input.occurrenceId === 'productivity-b-retry' && window.__productivityFixture.actions[5].input.expectedAttempts === 8 && window.__productivityFixture.actions[5].input.workspaceId === 'workspace-b'");
    await evaluate("window.__productivityFixture.settleAction(5,true)");
    await wait("document.querySelector('.schedule-occurrence-history [role=alert]')?.textContent.includes('提交被拒绝') && !document.querySelector('[data-occurrence-id=productivity-b-retry] button').disabled");
    await check('failed manual retry is visible and can be tried again without an unhandled rejection', "window.__productivityFixture.unhandled.length === 0");
    await evaluate("document.querySelector('[data-occurrence-id=productivity-b-retry] button').click()");
    await wait("window.__productivityFixture.actions.length === 7");
    await evaluate("window.__productivityFixture.markRetried();window.__productivityFixture.settleAction(6)");
    await wait("document.querySelector('[data-occurrence-id=productivity-b-retry]').textContent.includes('等待提交') && !document.querySelector('.schedule-occurrence-history button').disabled");
    await check('successful retry refreshes persisted submission state and clears the action error', "!document.querySelector('[data-occurrence-id=productivity-b-retry] button') && !document.querySelector('.schedule-occurrence-history [role=alert]')");
    await evaluate("window.__productivityFixture.failHistory(true);Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='刷新提交记录').click()");
    await wait("document.querySelector('.schedule-occurrence-history [role=alert]')?.textContent.includes('记录读取失败')");
    await evaluate("window.__productivityFixture.failHistory(false);Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='刷新提交记录').click()");
    await wait("!document.querySelector('.schedule-occurrence-history [role=alert]') && !document.querySelector('.schedule-occurrence-history button').disabled");
    await check('history loading failures are recoverable and preserve narrow panel layout', "window.__productivityFixture.unhandled.length === 0 && document.querySelector('.productivity-panel').scrollWidth <= innerWidth");
    await evaluate("Array.from(document.querySelectorAll('.productivity-panel button')).find(button=>button.textContent==='刷新').click()");
    await wait("window.__productivityFixture.queries.length === 7");
    await evaluate("window.__productivityFixture.settleQuery(6,'DEPENDENCY-GOAL',false,[{todoId:'todo-a',title:'FIRST-PREDECESSOR-'+ 'long'.repeat(60),status:'pending',ordinal:0,dependsOn:[]},{todoId:'todo-b',title:'SECOND-PREDECESSOR',status:'pending',ordinal:1,dependsOn:['todo-a']}])");
    await wait("document.querySelectorAll('.productivity-dependencies input[type=checkbox]').length === 2");
    await check('dependency controls display frozen edges and keep long labels inside a narrow panel', "document.querySelector('.productivity-panel ol').textContent.includes('前置：FIRST-PREDECESSOR') && document.querySelector('.productivity-panel').scrollWidth <= innerWidth");
    await evaluate("(()=>{const dependencyInput=document.querySelector('input[aria-label=新增待办]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(dependencyInput,'DEPENDENT-TASK');dependencyInput.dispatchEvent(new Event('input',{bubbles:true}));document.querySelectorAll('.productivity-dependencies input')[1].click()})()");
    await wait("!Array.from(document.querySelectorAll('.productivity-panel button')).find(button=>button.textContent==='添加').disabled");
    await evaluate("Array.from(document.querySelectorAll('.productivity-panel button')).find(button=>button.textContent==='添加').click()");
    await wait("window.__productivityFixture.actions.length === 8");
    await check('adding a dependent Todo preserves existing edges and sends the selected predecessor', "window.__productivityFixture.actions[7].kind==='replaceTodos' && window.__productivityFixture.actions[7].input.items[1].dependsOn[0]==='todo-a' && window.__productivityFixture.actions[7].input.items[2].dependsOn[0]==='todo-b'");
    await evaluate("window.__productivityFixture.settleAction(7)");
    await wait("window.__productivityFixture.queries.length === 8");
    await evaluate("window.__productivityFixture.settleQuery(7,'DEPENDENCY-GOAL')");
    await wait("!document.querySelector('.productivity-controls').disabled");
    await check('autonomous Goal requires nonempty unique criteria', "Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='开始自主推进').disabled");
    await evaluate("(()=>{const input=document.querySelector('textarea[aria-label=目标验收标准]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'ACTUAL-BEHAVIOR\\nACTUAL-BEHAVIOR');input.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await check('duplicate Goal criteria cannot be submitted', "Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='开始自主推进').disabled");
    await evaluate("(()=>{const input=document.querySelector('textarea[aria-label=目标验收标准]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'ACTUAL-BEHAVIOR\\nDURABLE-RESULT');input.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await wait("!Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='开始自主推进').disabled");
    await evaluate("(()=>{const button=Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='开始自主推进');button.click();button.click()})()");
    await wait("window.__productivityFixture.actions.length === 9 && document.querySelector('.productivity-controls').disabled");
    await check('autonomous start is single flight and freezes criteria and owner version', "window.__productivityFixture.actions[8].kind==='startGoalAutonomy' && window.__productivityFixture.actions[8].input.expectedVersion===8 && window.__productivityFixture.actions[8].input.sessionId==='productivity-b' && window.__productivityFixture.actions[8].input.criteria.join('|')==='ACTUAL-BEHAVIOR|DURABLE-RESULT' && Date.parse(window.__productivityFixture.actions[8].input.deadlineAt)>Date.now()");
    await evaluate("window.__productivityFixture.settleAction(8)");
    await wait("window.__productivityFixture.queries.length === 9");
    await evaluate("window.__goalAutonomyFixture={status:'planning',criteria:['ACTUAL-BEHAVIOR','DURABLE-RESULT'],deadlineAt:'2098-01-01T00:00:00Z',maxConcurrency:2,plannerAttempts:1,sessionId:'planner-session',runId:'planner-run',workflowId:null,summary:'EXACT-PLANNING'};window.__productivityFixture.settleQuery(8,'AUTONOMOUS-GOAL',false,[{todoId:'ready-task',title:'Ready task',status:'pending',ordinal:0}],window.__goalAutonomyFixture)");
    await wait("document.querySelector('[data-goal-autonomy-status=planning]') && !document.querySelector('.productivity-controls').disabled");
    await check('planning owns configuration and prevents a competing manual Workflow', "document.querySelector('input[aria-label=目标]').disabled && document.querySelector('textarea[aria-label=目标验收标准]').disabled && document.querySelector('input[aria-label=目标执行轮次上限]').disabled && Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='启动工作流').disabled");
    await evaluate("Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='暂停自主推进').click()");
    await wait("window.__productivityFixture.actions.length === 10");
    await check('pause uses the latest Goal CAS rather than a UI status edit', "window.__productivityFixture.actions[9].kind==='transitionGoalAutonomy' && window.__productivityFixture.actions[9].input.action==='pause' && window.__productivityFixture.actions[9].input.expectedVersion===9");
    await evaluate("window.__productivityFixture.settleAction(9)");
    await wait("window.__productivityFixture.queries.length === 10");
    await evaluate("window.__productivityFixture.settleQuery(9,'AUTONOMOUS-GOAL',false,[],{...window.__goalAutonomyFixture,status:'stopping'})");
    await wait("document.querySelector('[data-goal-autonomy-status=stopping]') && !document.querySelector('.productivity-controls').disabled");
    await check('stopping remains visible until actual tasks join and exposes no resume', "document.querySelector('.goal-autonomy-controls').textContent.includes('正在等待规划和执行任务确认结束') && !Array.from(document.querySelectorAll('.goal-autonomy-controls button')).some(button=>button.textContent==='继续自主推进')");
    await wait("window.__productivityFixture.queries.length === 11", 8_000);
    await check('active autonomy polls without a running Workflow or Schedule', "window.__productivityFixture.queries[10].sessionId==='productivity-b'");
    await evaluate("window.__productivityFixture.settleQuery(10,'AUTONOMOUS-GOAL',false,[],{...window.__goalAutonomyFixture,status:'paused'})");
    await wait("document.querySelector('[data-goal-autonomy-status=paused]')");
    await evaluate("Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='继续自主推进').click()");
    await wait("window.__productivityFixture.actions.length === 11");
    await check('resume goes through the formal owner command', "window.__productivityFixture.actions[10].input.action==='resume' && window.__productivityFixture.actions[10].input.expectedVersion===11");
    await evaluate("window.__productivityFixture.settleAction(10)");
    await wait("window.__productivityFixture.queries.length === 12");
    await evaluate("window.__productivityFixture.settleQuery(11,'AUTONOMOUS-GOAL',false,[],{...window.__goalAutonomyFixture,status:'complete',completedBy:'verification',summary:'VERIFIED',assessment:[{criterion:1,status:'passed',evidence:'DURABLE-RESULT-EVIDENCE'},{criterion:0,status:'passed',evidence:'ACTUAL-BEHAVIOR-EVIDENCE-'+ 'long'.repeat(80)}]})");
    await wait("document.querySelector('ol[aria-label=目标逐项验收结果]')");
    await check('verified completion displays every numbered criterion and its evidence inside a narrow panel', "document.querySelector('ol[aria-label=目标逐项验收结果] li:first-child').textContent.includes('ACTUAL-BEHAVIOR-EVIDENCE') && document.querySelector('ol[aria-label=目标逐项验收结果] li:last-child').textContent.includes('DURABLE-RESULT-EVIDENCE') && document.querySelector('.productivity-panel').scrollWidth<=innerWidth");
    await evaluate("Array.from(document.querySelectorAll('.goal-autonomy-controls button')).find(button=>button.textContent==='查看规划与验收会话').click()");
    await wait("window.__productivityFixture.selectedSessions.length===1 && window.__productivityFixture.queries.length===13");
    await check('the Goal opens its actual planner session', "window.__productivityFixture.selectedSessions[0]==='planner-session'");
    await evaluate("window.__productivityFixture.settleQuery(12,'AUTONOMOUS-GOAL',false,[],{...window.__goalAutonomyFixture,status:'complete',completedBy:'user',summary:'MANUAL'})");
    await wait("document.querySelector('.goal-autonomy-controls').textContent.includes('用户标记完成，未进行自主验收')");
    await check('manual completion is not presented as a passed autonomous assessment', "!document.querySelector('ol[aria-label=目标逐项验收结果]') && window.__productivityFixture.unhandled.length===0");
    await evaluate("window.__productivityFixture.setExecution({status:'running',runId:'actual-schedule-run',resultPending:false,resultSummary:null});Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='刷新提交记录').click()");
    await wait("document.querySelector('[data-schedule-run-id=actual-schedule-run]')?.textContent.includes('执行中') && !document.querySelector('.schedule-occurrence-history button').disabled");
    await check('submitted occurrences expose the actual Run and keep execution separate', "document.querySelector('[data-occurrence-id=productivity-b-executing]').textContent.includes('已提交到会话') && document.querySelector('[data-schedule-run-id=actual-schedule-run]').textContent.includes('Run：actual-schedule-run')");
    await evaluate("window.__schedulePollBaseline=window.__productivityFixture.historyQueries.length");
    await wait("window.__productivityFixture.historyQueries.length>window.__schedulePollBaseline", 8_000);
    await check('actual execution continues polling after submission has finished', "document.querySelector('[data-schedule-run-id=actual-schedule-run]').textContent.includes('执行中') && !document.querySelector('[data-occurrence-id=productivity-b-executing]').textContent.includes('等待提交')");
    await evaluate("window.__productivityFixture.setExecution({status:'completed',runId:'actual-schedule-run',resultPending:true,resultSummary:null});Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='刷新提交记录').click()");
    await wait("document.querySelector('[data-schedule-run-id=actual-schedule-run]')?.textContent.includes('正在同步会话结果')");
    await evaluate("window.__productivityFixture.setExecution({status:'completed',runId:'actual-schedule-run',resultPending:false,resultSummary:'ACTUAL-SCHEDULE-RESULT-'+ 'long'.repeat(900)});Array.from(document.querySelectorAll('.schedule-occurrence-history button')).find(b=>b.textContent==='刷新提交记录').click()");
    await wait("document.querySelector('.schedule-execution-summary')?.textContent.includes('ACTUAL-SCHEDULE-RESULT') && !document.querySelector('.schedule-execution-result button').disabled");
    await check('actual terminal results remain readable inside a narrow panel', "document.querySelector('.schedule-execution-result strong').textContent.includes('执行完成') && document.querySelector('.productivity-panel').scrollWidth<=innerWidth");
    await evaluate("window.__productivityFixture.failSessionSelection(true);document.querySelector('.schedule-execution-result button').click()");
    await wait("document.querySelector('.schedule-occurrence-history [role=alert]')?.textContent.includes('所属会话打开失败')");
    await check('opening the result owner catches selection failures', "window.__productivityFixture.unhandled.length===0");
    await evaluate("window.__productivityFixture.failSessionSelection(false);document.querySelector('.schedule-execution-result button').click()");
    await wait("window.__productivityFixture.selectedSessions.length===2 && !document.querySelector('.schedule-occurrence-history [role=alert]')");
    await check('the actual result opens its owning session', "window.__productivityFixture.selectedSessions[1]==='productivity-b'");
    if (productivityReviewDirectory) {
      await evaluate("document.querySelector('.schedule-occurrence-history').scrollIntoView({block:'start'})");
      writeFileSync(join(productivityReviewDirectory, 'schedule-submissions.png'), (await wc.capturePage()).toPNG());
    }

    window.setContentSize(500, 400);
    await evaluate("window.__uiFixture.show('workspace')");
    await wait("window.__workspaceFixture.api?.panels.length === 8 && !!document.querySelector('.workspace-group-tabs .select-menu-trigger')");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const wholeTabs = "(() => { const strip = document.querySelector('.dv-tabs-container[aria-orientation=horizontal]'); const bounds = strip.getBoundingClientRect(); const tabs = Array.from(strip.querySelectorAll(':scope > .dv-tab')); const active = tabs.find(t => t.querySelector('[data-module-id]')?.dataset.moduleId === window.__workspaceFixture.api.activePanel?.id)?.getBoundingClientRect(); return bounds.width > 100 && active && active.left >= bounds.left - 1 && active.right <= bounds.right + 1 && tabs.every(t => { const r = t.getBoundingClientRect(); return r.right <= bounds.left + 1 || r.left >= bounds.right - 1 || (r.left >= bounds.left - 1 && r.right <= bounds.right + 1); }); })()";
    await check('initial workspace keeps the selected tab visible and shows only whole tabs', wholeTabs);
    await check('horizontal tab sizing is applied on initial Dockview markup', "document.querySelector('.dv-tabs-container > .dv-tab').getBoundingClientRect().width >= 156");
    await evaluate("document.querySelector('.workspace-group-tabs .select-menu-trigger').focus()");
    await key('Down');
    await wait("document.activeElement?.getAttribute('role') === 'option' && !!document.querySelector('.workspace-group-tab-list')");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await wait("document.querySelector('.workspace-group-tab-list').getAnimations().every(a => a.playState === 'finished')");
    await check('all-tabs menu has distinct readable rows without tab actions', "(() => { const menu = document.querySelector('.workspace-group-tab-list'); const rows = Array.from(menu.querySelectorAll('[role=option]')).map(e => e.getBoundingClientRect()); return rows.length === 8 && !menu.querySelector('.module-tab-actions') && rows.every((r,i) => r.height >= 33.99 && (!i || r.top >= rows[i-1].bottom - .01)); })()");
    await check('keyboard opening focuses the selected tab without changing selection', "document.activeElement.getAttribute('aria-selected') === 'true' && window.__workspaceFixture.api.activePanel.id === 'fixture.panel-7'");
    await key('Home');
    await check('Home focuses the first menu option', "document.activeElement.textContent === '会话'");
    await key('Down');
    await check('Down moves through the all-tabs menu', "document.activeElement.textContent === '文件浏览'");
    await key('End');
    await key('Up');
    await check('End and Up preserve keyboard navigation', "document.activeElement.textContent === '运行日志'");
    await key('Escape');
    await wait("!document.querySelector('.workspace-group-tab-list') && document.activeElement.closest('.workspace-group-tabs')");
    await check('Escape returns focus without selecting a different tab', "window.__workspaceFixture.api.activePanel.id === 'fixture.panel-7'");
    await key('Enter');
    await wait("!!document.querySelector('.workspace-group-tab-list') && document.activeElement?.getAttribute('role') === 'option'");
    if (process.argv.includes('--capture')) {
      const directory = mkdtempSync(join(tmpdir(), 'ariadne-tabs-review-'));
      await wait("document.querySelector('.workspace-group-tab-list').getAnimations().every(a => a.playState === 'finished')");
      writeFileSync(join(directory, 'overflow.png'), (await wc.capturePage()).toPNG());
      console.log(`TABS_REVIEW_ARTIFACTS ${directory}`);
    }
    await key('Home');
    await wait("document.activeElement.textContent === '会话'");
    await key('Enter');
    await wait("window.__workspaceFixture.api.activePanel.id === 'fixture.panel-0' && !document.querySelector('.workspace-group-tab-list') && document.activeElement.closest('.workspace-group-tabs')");
    await wait(wholeTabs);
    await check('overflow selection returns to a complete first tab without scrolling the page', `${wholeTabs} && document.documentElement.scrollTop === 0`);
    for (const width of [280, 360, 500, 900, 1400]) {
      window.setContentSize(width, 400);
      await wait(`innerWidth === ${width}`);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await wait(wholeTabs);
      for (const index of [0, 3, 7]) {
        await evaluate(`window.__workspaceFixture.api.getPanel('fixture.panel-${index}').api.setActive()`);
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        await wait(wholeTabs);
      }
      await check(`first, middle and last tabs remain whole at ${width}px width`, wholeTabs);
    }
    await evaluate("window.__workspaceFixture.api.fromJSON(window.__workspaceFixture.api.toJSON())");
    await wait(wholeTabs);
    await check('restoring a serialized workspace preserves active tab and panel count', `${wholeTabs} && window.__workspaceFixture.api.panels.length === 8`);
    window.setContentSize(500, 400);
    await evaluate("window.__workspaceFixture.api.groups[0].api.setHeaderPosition('bottom')");
    await wait("!!document.querySelector('.dv-groupview-header-bottom')");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await wait(wholeTabs);
    await check('bottom-docked horizontal header keeps whole tabs', wholeTabs);
    for (const zoom of [1.25, 1.5]) {
      wc.setZoomFactor(zoom);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await wait(wholeTabs);
      await check(`${zoom * 100}% zoom preserves whole selected tabs`, wholeTabs);
    }
    wc.setZoomFactor(1);
    await evaluate("window.__workspaceFixture.api.groups[0].api.setHeaderPosition('left')");
    await wait("!!document.querySelector('.dv-tabs-container[aria-orientation=vertical]')");
    await check('vertical headers are not assigned horizontal slot containment', "getComputedStyle(document.querySelector('.dv-tabs-container')).containerType === 'normal' && document.querySelector('.dv-tabs-container').getBoundingClientRect().height > 100");
    await evaluate("window.__workspaceFixture.api.groups[0].api.setHeaderPosition('top'); window.__workspaceFixture.setTheme('light')");
    await wait("!!document.querySelector('.dv-tabs-container[aria-orientation=horizontal]')");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await wait(wholeTabs);
    await check('returning from a vertical header keeps the active tab in view', wholeTabs);
    await wait("getComputedStyle(document.querySelector('.dv-tabs-container > .dv-active-tab')).backgroundColor === 'rgb(250, 250, 250)'");
    await check('light theme settles to the correct active-tab surface', "getComputedStyle(document.querySelector('.dv-tabs-container > .dv-active-tab')).color === 'rgb(37, 40, 50)'");
    window.setContentSize(320, 240);
    await wait('innerWidth === 320 && innerHeight === 240');
    await evaluate("document.querySelector('.workspace-group-tabs .select-menu-trigger').focus()");
    await key('Enter');
    await wait("!!document.querySelector('.workspace-group-tab-list') && document.activeElement?.getAttribute('role') === 'option'");
    await wait("document.querySelector('.workspace-group-tab-list').getAnimations().every(a => a.playState === 'finished')");
    await check('short-window tab menu stays inside the viewport', "(() => {const r=document.querySelector('.workspace-group-tab-list').getBoundingClientRect();return r.left >= 7.9 && r.right <= innerWidth - 7.9 && r.top >= 7.9 && r.bottom <= innerHeight - 7.9;})()");
    await key('Home');
    await key('End');
    await check('tab menu keyboard scrolling is local and keeps the last option visible', "(() => { const menu=document.querySelector('.workspace-group-tab-list'); const r=document.activeElement.getBoundingClientRect();const bounds=menu.getBoundingClientRect();return menu.scrollTop > 0 && r.top >= bounds.top-1 && r.bottom <= bounds.bottom+1 && document.documentElement.scrollTop === 0; })()");
    await evaluate("window.__workspaceFixture.api.getPanel('fixture.panel-7').api.setTitle('【UI 夹具】重命名')");
    await wait("document.querySelector('.workspace-group-tab-list')?.textContent.includes('【UI 夹具】重命名') && document.querySelector('.module-tab[data-module-id=\"fixture.panel-7\"]')?.textContent.includes('【UI 夹具】重命名')");
    await check('renaming a panel updates both its tab and open menu', "document.querySelector('.workspace-group-tab-list').textContent.includes('【UI 夹具】重命名')");
    await key('Escape');
    await wait("!document.querySelector('.workspace-group-tab-list')");
    await evaluate("window.__workspaceFixture.api.getPanel('fixture.panel-7').api.setTitle('目标与工作流')");
    window.setContentSize(500, 400);
    let popout;
    wc.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false } }));
    wc.once('did-create-window', created => { popout = created; });
    const popoutOpened = await wc.executeJavaScript("window.__workspaceFixture.api.addPopoutGroup(window.__workspaceFixture.api.groups[0], {popoutUrl: new URL('popout.html', location.href).href, position:{left:80,top:80,width:420,height:320}})", true);
    if (!popoutOpened) throw new Error('Dockview rejected the same-origin fixture popout');
    await wait("window.__workspaceFixture.api.getPopouts().length === 1 && !!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tabs .select-menu-trigger')");
    if (!popout) throw new Error('Dockview did not create a fixture popout window');
    popout.setContentSize(420, 320);
    popout.setTitle('Ariadne UI fixture — popout');
    popout.show();
    popout.focus();
    const childTabVisible = "(() => {const d=window.__workspaceFixture.api.getPopouts()[0].window.document; const r=d.querySelector('.dv-tabs-container > .dv-active-tab').getBoundingClientRect();const b=d.querySelector('.dv-tabs-container').getBoundingClientRect();return b.width > 100 && r.left >= b.left-1 && r.right <= b.right+1;})()";
    await wait(childTabVisible);
    await check('new popout inherits whole-tab sizing and reveals its active tab', `(() => {const d=window.__workspaceFixture.api.getPopouts()[0].window.document;return d.querySelector('.dv-tabs-container > .dv-tab').getBoundingClientRect().width >= 156;})() && ${childTabVisible}`);
    const childKey = async keyCode => {
      popout.webContents.sendInputEvent({type:'keyDown', keyCode});
      popout.webContents.sendInputEvent({type:'keyUp', keyCode});
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    await evaluate("window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tabs .select-menu-trigger').focus()");
    await childKey('Enter');
    await wait("!!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list')");
    await check('popout menu belongs to the popout document, not the main window', "!document.querySelector('.workspace-group-tab-list') && window.__workspaceFixture.api.getPopouts()[0].window.document.activeElement?.getAttribute('role') === 'option'");
    if (process.argv.includes('--capture')) {
      const directory = mkdtempSync(join(tmpdir(), 'ariadne-popout-review-'));
      await wait("window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list').getAnimations().every(a => a.playState === 'finished')");
      writeFileSync(join(directory, 'tab-menu.png'), (await popout.webContents.capturePage()).toPNG());
      console.log(`POPOUT_REVIEW_ARTIFACTS ${directory}`);
    }
    await childKey('Home');
    await childKey('Enter');
    await wait("!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list') && window.__workspaceFixture.api.getPanel('fixture.panel-0').api.isActive");
    await check('popout keyboard selection activates the panel and returns focus locally', "window.__workspaceFixture.api.getPopouts()[0].window.document.activeElement?.closest('.workspace-group-tabs') !== null");
    await wait(childTabVisible);
    await check('popout activation reveals the first tab without a size change', childTabVisible);
    await evaluate("window.__workspaceFixture.api.getPanel('fixture.panel-7').api.setActive()");
    await wait(childTabVisible);
    await check('programmatic popout activation reveals the last tab without resizing', childTabVisible);
    await childKey('Down');
    await wait("!!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list')");
    const activeBeforeOutsideClick = await evaluate("window.__workspaceFixture.api.getPopouts()[0].group.activePanel.id");
    if (!await evaluate("window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list').getBoundingClientRect().left > 12")) throw new Error('Outside-click point is inside the menu');
    popout.webContents.sendInputEvent({type:'mouseDown', x:12, y:290, button:'left', clickCount:1});
    popout.webContents.sendInputEvent({type:'mouseUp', x:12, y:290, button:'left', clickCount:1});
    await wait("!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list')");
    await check('outside pointer in a popout dismisses its menu without selecting a tab', `!window.__workspaceFixture.api.getPopouts()[0].window.document.querySelector('.workspace-group-tab-list') && window.__workspaceFixture.api.getPopouts()[0].group.activePanel.id === ${JSON.stringify(activeBeforeOutsideClick)}`);
    window.hide();
    popout.setContentSize(280, 240);
    await wait(childTabVisible);
    await check('popout resize keeps the active tab visible while its opener is hidden', childTabVisible);
    await evaluate("window.__workspaceFixture.api.getPopouts()[0].window.dispatchEvent(new Event('resize'))");
    popout.close();
    await wait("window.__workspaceFixture.api.getPopouts().length === 0 && !!document.querySelector('.workspace-group-tabs')");
    window.show();
    window.focus();
    await check('closing a fixture popout restores its panels to the main workspace', "window.__workspaceFixture.api.panels.length === 8");
    await evaluate("window.__workspaceSaved = window.__workspaceFixture.api.toJSON(); window.__workspaceFixture.api.getPanel('fixture.panel-7').api.close()");
    await wait("document.querySelector('.workspace-group-tabs .select-menu-value')?.textContent === '7'");
    await evaluate("document.querySelector('.workspace-group-tabs .select-menu-trigger').focus()");
    await key('Enter');
    await wait("document.querySelectorAll('.workspace-group-tab-list [role=option]').length === 7");
    await check('closing a panel removes it from the tab chooser and count', "!document.querySelector('.workspace-group-tab-list').textContent.includes('目标与工作流')");
    await key('Escape');
    await evaluate("window.__workspaceFixture.api.fromJSON(window.__workspaceSaved)");
    await wait("document.querySelector('.workspace-group-tabs .select-menu-value')?.textContent === '8'");
    window.setContentSize(500,600);
    await evaluate("(()=>{const api=window.__workspaceFixture.api;window.__navigationSaved=api.toJSON();const left=api.getPanel('fixture.panel-0'),right=api.getPanel('fixture.panel-2');right.api.moveTo({position:'right',group:left.group});left.group.api.setConstraints({minimumWidth:380});right.group.api.setConstraints({minimumWidth:380});})()");
    console.log('NAVIGATION_FIXTURE_GEOMETRY', await evaluate("JSON.stringify({innerWidth,host:document.querySelector('.ariadne-dockview-host').getBoundingClientRect().toJSON(),groups:window.__workspaceFixture.api.groups.map(group=>({id:group.id,minimumWidth:group.minimumWidth,bounds:group.element.getBoundingClientRect().toJSON(),panels:group.panels.map(panel=>panel.id)}))})"));
    await wait("window.__workspaceFixture.api.getPanel('fixture.panel-2').group.element.getBoundingClientRect().right>innerWidth");
    await evaluate("window.__workspaceFixture.openModule('fixture.panel-2')");
    await wait("window.__workspaceFixture.api.getPanel('fixture.panel-2').api.isMaximized()");
    await check('explicit module navigation reveals a panel clipped by other groups minimum widths', "(()=>{const rect=window.__workspaceFixture.api.getPanel('fixture.panel-2').group.element.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1;})()");
    await evaluate("window.__workspaceFixture.openModule('fixture.panel-0')");
    await wait("window.__workspaceFixture.api.getPanel('fixture.panel-0').api.isVisible");
    await check('navigation out of a maximized group reveals the next module', "window.__workspaceFixture.api.activePanel.id==='fixture.panel-0'");
    await evaluate("window.__workspaceFixture.api.fromJSON(window.__navigationSaved)");
    await evaluate("(()=>{const fixture=window.__workspaceFixture,api=fixture.api;api.getPanel('fixture.panel-2').api.setActive();const layout=api.toJSON();for(const panel of Object.values(layout.panels))panel.minimumWidth=1;layout.panels['fixture.panel-2'].params={...layout.panels['fixture.panel-2'].params,restorationEvidence:'persisted-layout'};fixture.restoreLayout(layout);})()");
    await wait("!!window.__workspaceFixture.api && window.__workspaceFixture.api.activePanel?.id==='fixture.panel-2'");
    await check('cold layout restore applies current module constraints and retains persisted panel identity', "(()=>{const layout=window.__workspaceFixture.api.toJSON();return Object.values(layout.panels).every(panel=>panel.minimumWidth===100)&&layout.panels['fixture.panel-2'].params.restorationEvidence==='persisted-layout';})()");
    if (process.argv.includes('--capture')) {
      const directory = mkdtempSync(join(tmpdir(), 'ariadne-tabs-layout-'));
      writeFileSync(join(directory, 'light-tabs.png'), (await wc.capturePage()).toPNG());
      console.log(`TABS_LAYOUT_ARTIFACTS ${directory}`);
    }
    window.setContentSize(360, 600);
    }
    window.setContentSize(360,600);
    wc.setWindowOpenHandler(() => ({action:'allow',overrideBrowserWindowOptions:{show:false,width:360,height:600}}));
    await evaluate("window.__uiFixture.show('memory')");
    await wait('window.__memoryFixture.queryCount() === 1');
    await check('memory page waits for its production query', "document.body.textContent.includes('正在加载记忆') && !document.querySelector('[aria-label=记忆详情]')");
    await evaluate('window.__memoryFixture.resolvePage(0, true)');
    await wait("document.querySelectorAll('[aria-label=记忆列表] li').length === 2");
    await evaluate("document.querySelector('[aria-label=记忆列表] button').click()");
    await wait("document.body.textContent.includes('尚未审核')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '审核并启用').click()");
    await wait('window.__memoryFixture.operationCount() === 1');
    await check('memory review waits for authoritative settlement and carries the displayed version', "document.body.textContent.includes('正在处理') && window.__memoryFixture.operations()[0].args[1].version === 1 && window.__memoryFixture.operations()[0].args[2] === 'activate'");
    await evaluate('window.__memoryFixture.rejectOperation(0)');
    await wait("document.body.textContent.includes('版本冲突，请刷新')");
    await check('failed memory review leaves candidate data unchanged', "document.querySelector('[aria-label=记忆详情]').textContent.includes('待审核') && document.querySelector('[aria-label=记忆详情]').textContent.includes('v1')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '审核并启用').click()");
    await wait('window.__memoryFixture.operationCount() === 2');
    await evaluate('window.__memoryFixture.resolveOperation(1)');
    await wait('window.__memoryFixture.queryCount() === 2');
    await evaluate('window.__memoryFixture.resolvePage(1, true)');
    await wait("document.querySelector('[aria-label=记忆详情]')?.textContent.includes('v2')");
    await check('successful memory review reloads actual version and state', "document.querySelector('[aria-label=记忆详情]').textContent.includes('已启用') && !document.body.textContent.includes('版本冲突，请刷新')");
    await check('long memory content wraps inside a narrow panel', "document.querySelector('.memory-panel').scrollWidth <= document.querySelector('.memory-panel').clientWidth");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '加载更多记忆').click()");
    await wait('window.__memoryFixture.queryCount() === 3');
    await evaluate('window.__memoryFixture.resolvePage(2)');
    await wait("!Array.from(document.querySelectorAll('button')).some(button => button.textContent === '加载更多记忆')");
    await check('memory pagination uses the exact cursor and avoids duplicate records', "window.__memoryFixture.operations().length === 2 && document.querySelectorAll('[aria-label=记忆列表] li').length === 2");
    await evaluate("(() => { const input=document.querySelector('[aria-label=记忆召回关键词]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'SQLite');input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await evaluate("document.querySelector('[aria-label=记忆召回关键词]').form.requestSubmit()");
    await wait('window.__memoryFixture.recallCount() === 1');
    await evaluate('window.__memoryFixture.resolveRecall(0)');
    await wait("!!document.querySelector('[aria-label=记忆召回结果]')");
    await check('memory UI identifies lexical approximation without claiming semantic inference', "document.querySelector('[aria-label=记忆召回结果]').textContent.includes('词法近似，不代表神经语义理解') && document.querySelector('[aria-label=记忆召回结果]').textContent.includes('256 维')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '忘记记忆').click()");
    await check('forgetting memory requires a concrete inline confirmation', "window.__memoryFixture.operationCount() === 2 && document.body.textContent.includes('无法恢复')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认忘记').click()");
    await wait('window.__memoryFixture.operationCount() === 3');
    await check('forget command is bound to the latest reviewed version', "window.__memoryFixture.operations()[2].args[1].version === 2");
    await evaluate('window.__memoryFixture.resolveOperation(2)');
    await wait('window.__memoryFixture.queryCount() === 4');
    await evaluate('window.__memoryFixture.resolvePage(3)');
    await wait("document.querySelectorAll('[aria-label=记忆列表] li').length === 1");
    await check('forgotten memory disappears from details and recall', "!document.querySelector('[aria-label=记忆详情]') && !document.querySelector('[aria-label=记忆召回结果]') && !document.querySelector('[aria-label=记忆列表]').textContent.includes('candidate')");
    await evaluate("document.querySelector('[aria-label=记忆召回关键词]').form.requestSubmit()");
    await wait('window.__memoryFixture.recallCount() === 2');
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '刷新').click()");
    // The ongoing recall locks other actions. Start the query only after switching away.
    await evaluate('window.__memoryFixture.switchSession()');
    await wait('window.__memoryFixture.queryCount() === 5');
    await evaluate('window.__memoryFixture.resolveRecall(1, true); window.__memoryFixture.resolvePage(4, false, true)');
    await wait("document.body.textContent.includes('当前筛选下没有记忆')");
    await check('late memory recall cannot cross session boundaries', "!document.body.textContent.includes('STALE MEMORY RECALL') && !document.querySelector('[aria-label=记忆详情]')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '新增记忆').click()");
    await wait("!!document.querySelector('[aria-label=记忆标题]')");
    await check('new memory editor fits a narrow panel and rejects empty data', "document.querySelector('.memory-panel').scrollWidth <= document.querySelector('.memory-panel').clientWidth && document.querySelector('.memory-editor button[type=submit]').disabled");
    for(const [index,reason,expected] of [[2,'model_unavailable','本地模型不可用'],[3,'index_rebuild_required','索引正在准备或重建'],[4,null,'请稍后重试或使用更具体的关键词']]){
      await evaluate("(()=>{const input=document.querySelector('[aria-label=记忆召回关键词]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'SQLite');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await evaluate("document.querySelector('[aria-label=记忆召回关键词]').form.requestSubmit()");
      await wait('window.__memoryFixture.recallCount() === '+(index+1));
      await evaluate('window.__memoryFixture.resolveLimitedRecall('+index+','+JSON.stringify(reason)+')');
      await wait("document.querySelector('[aria-label=记忆召回结果]')?.textContent.includes("+JSON.stringify(expected)+")");
      await check('incomplete memory recall renders accurate retry guidance '+String(reason),"document.querySelector('[aria-label=记忆召回结果]').textContent.includes('本次召回未完整完成') && document.querySelector('.memory-panel').scrollWidth <= document.querySelector('.memory-panel').clientWidth");
    }
    await require('./smoke/memory-editing-ui.cjs')({evaluate,wait,check});
    if(!memoryOnly){
    await require('./smoke/model-selection-ui.cjs')({window,wc,evaluate,wait,check,key});
    await require('./smoke/settings-models-ui.cjs')({window,wc,evaluate,wait,check});
    }
    }
    if(!memoryOnly){
    window.setContentSize(360, 600);
    await evaluate("window.__uiFixture.show('documents')");
    await wait('window.__documentsFixture.count() === 1');
    await evaluate("window.__documentsFixture.resolveRead(0, '第一行\\r\\n第二行\\r\\n')");
    await wait("document.querySelector('[aria-label=文件正文]')?.value === '第一行\\n第二行\\n'");
    const documentInput = async value => evaluate(`(() => {const input=document.querySelector('[aria-label=文件正文]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const documentButton = text => evaluate(`Array.from(document.querySelectorAll('.workspace-document-editor button')).find(button=>button.textContent===${JSON.stringify(text)}).click()`);
    const confirmDocument = async () => evaluate("document.querySelector('.action-dialog footer button:last-child').click()");
    await documentInput('编辑后\n中文\n');
    await documentButton('保存文件');
    await wait('window.__documentsFixture.count() === 2');
    await check('file save preserves CRLF and carries the observed freshness token', "window.__documentsFixture.commands()[1].content === '编辑后\\r\\n中文\\r\\n' && window.__documentsFixture.commands()[1].expectedVersion === 'workspace-file-v1:' + 'a'.repeat(63) + '0'");
    await check('pending saves keep newer edits available while locking conflicting file operations', "!document.querySelector('[aria-label=文件正文]').readOnly && Array.from(document.querySelectorAll('.workspace-document-actions button')).filter(button=>['保存文件','重新读取','重命名或移动','删除文件','关闭文件'].includes(button.textContent)).every(button=>button.disabled)");
    await evaluate('window.__documentsFixture.reject(1)');
    await wait("document.querySelector('[role=alert]')?.textContent.includes('文件版本冲突')");
    await check('failed file saves retain the exact unsaved draft', "document.querySelector('[aria-label=文件正文]').value === '编辑后\\n中文\\n' && window.__documentsFixture.draft('workspace-a','first.txt').content === '编辑后\\r\\n中文\\r\\n'");
    await documentButton('保存文件');
    await wait('window.__documentsFixture.count() === 3');
    await evaluate('window.__documentsFixture.resolveMutation(2)');
    await wait("document.querySelector('.workspace-document-editor [role=status]')?.textContent === '已保存。'");
    await documentInput('草稿保留\n');
    await evaluate("window.__documentsFixture.select('second.txt')");
    await wait('window.__documentsFixture.count() === 4');
    await evaluate("window.__documentsFixture.select('third.txt')");
    await wait('window.__documentsFixture.count() === 5');
    await evaluate("window.__documentsFixture.resolveRead(3,'STALE FILE READ');window.__documentsFixture.resolveRead(4,'【UI 夹具】第三个文件')");
    await wait("document.querySelector('[aria-label=文件正文]')?.value === '【UI 夹具】第三个文件'");
    await check('late file reads cannot replace a different selected document', "!document.querySelector('.workspace-document-editor').textContent.includes('STALE FILE READ') && !document.querySelector('[aria-label=文件正文]').value.includes('STALE')");
    await evaluate("window.__documentsFixture.select('first.txt')");
    await wait("document.querySelector('[aria-label=文件正文]')?.value === '草稿保留\\n'");
    await check('switching files retains unsaved drafts without another disk read', "window.__documentsFixture.count() === 5 && document.querySelector('.workspace-document-editor').textContent.includes('有未保存修改')");
    await documentButton('关闭文件');
    await wait("!!document.querySelector('.action-dialog')");
    await evaluate("document.querySelector('.action-dialog footer button:first-child').click()");
    await wait("!document.querySelector('.action-dialog')");
    await check('cancelling close keeps the unsaved document open', "document.querySelector('[aria-label=文件正文]').value === '草稿保留\\n'");
    await documentButton('重命名或移动');
    await wait("document.querySelector('.action-dialog-field input')?.value === 'first.txt'");
    await evaluate("(() => {const input=document.querySelector('.action-dialog-field input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'folder/moved.txt');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await evaluate("document.querySelector('form.action-dialog').requestSubmit()");
    await wait('window.__documentsFixture.count() === 6');
    await evaluate('window.__documentsFixture.resolveMutation(5)');
    // The header changes before the moved document finishes restoring its draft.
    await wait("document.querySelector('.workspace-document-editor header strong')?.textContent === 'folder/moved.txt' && document.querySelector('[aria-label=文件正文]')?.value === '草稿保留\\n'");
    await check('moving a file transfers its unsaved draft and fresh version together', "document.querySelector('[aria-label=文件正文]').value === '草稿保留\\n' && window.__documentsFixture.draft('workspace-a','folder/moved.txt').version.endsWith('5') && !window.__documentsFixture.draft('workspace-a','first.txt')");
    await documentButton('保存文件');
    await wait('window.__documentsFixture.count() === 7');
    await evaluate('window.__documentsFixture.resolveMutation(6)');
    await wait("document.querySelector('.workspace-document-editor [role=status]')?.textContent === '已保存。'");
    await documentButton('删除文件');
    await wait("document.querySelector('.action-dialog h2')?.textContent === '删除文件'");
    await check('file deletion waits for explicit confirmation', "window.__documentsFixture.count() === 7 && document.querySelector('.action-dialog').textContent.includes('永久删除')");
    await confirmDocument();
    await wait('window.__documentsFixture.count() === 8');
    await evaluate('window.__documentsFixture.resolveMutation(7)');
    await wait("!document.querySelector('.workspace-document-editor')");
    await check('completed deletion removes the editor draft', "!window.__documentsFixture.draft('workspace-a','folder/moved.txt')");
    await evaluate("window.__documentsFixture.select('readonly.txt')");
    await wait('window.__documentsFixture.count() === 9');
    await evaluate("window.__documentsFixture.resolveRead(8,'【UI 夹具】只读正文',false)");
    await wait("document.querySelector('[aria-label=文件正文]')?.readOnly");
    await check('read-only workspaces disable save, move and delete', "Array.from(document.querySelectorAll('.workspace-document-actions button')).filter(button=>['保存文件','重命名或移动','删除文件'].includes(button.textContent)).every(button=>button.disabled)");
    await evaluate("window.__documentsFixture.select('mixed.txt')");
    await wait('window.__documentsFixture.count() === 10');
    await evaluate("window.__documentsFixture.resolveRead(9,'first\\r\\nsecond\\n')");
    await wait("document.querySelector('.workspace-document-editor')?.textContent.includes('混用换行格式')");
    await check('mixed newlines are preserved by opening the file read-only', "document.querySelector('[aria-label=文件正文]').readOnly && window.__documentsFixture.draft('workspace-a','mixed.txt').content === 'first\\r\\nsecond\\n'");
    await evaluate("window.__documentsFixture.select('new.txt','workspace-a',true)");
    await wait("document.querySelector('[aria-label=文件正文]')?.value === '' && !document.querySelector('[aria-label=文件正文]').readOnly");
    await documentInput('【UI 夹具】新文件');await documentButton('保存文件');
    await wait('window.__documentsFixture.count() === 11');
    await check('new files require create-if-absent instead of an implicit overwrite', "window.__documentsFixture.commands()[10].expectedVersion === null");
    await evaluate('window.__documentsFixture.resolveMutation(10)');
    await wait("document.querySelector('.workspace-document-editor [role=status]')?.textContent === '已保存。'");
    await documentInput('【UI 夹具】保留此草稿');await documentButton('重新读取');
    await wait("document.querySelector('.action-dialog h2')?.textContent === '重新读取文件'");
    await confirmDocument();await wait('window.__documentsFixture.count() === 12');await evaluate('window.__documentsFixture.reject(11)');
    await wait("!!document.querySelector('.workspace-document-editor [role=alert]')");
    await check('failed reload leaves the unsaved file content intact', "document.querySelector('[aria-label=文件正文]').value === '【UI 夹具】保留此草稿'");
    await check('file editor fits the narrow panel without horizontal overflow', "document.querySelector('.workspace-document-editor').scrollWidth <= document.querySelector('.workspace-document-editor').clientWidth && document.querySelector('.file-explorer').getBoundingClientRect().bottom <= innerHeight");
    await documentInput('A 捕获修订');await documentButton('保存文件');await wait('window.__documentsFixture.count() === 13');
    await documentInput('B 后续编辑');await evaluate('window.__documentsFixture.resolveMutation(12)');
    await wait("!window.__documentsFixture.draft('workspace-a','new.txt').pendingMutation");
    await check('late A save success leaves B editable and updates only the disk baseline', "document.querySelector('[aria-label=文件正文]').value === 'B 后续编辑' && window.__documentsFixture.draft('workspace-a','new.txt').originalContent === 'A 捕获修订'");
    await documentButton('保存文件');await wait('window.__documentsFixture.count() === 14');
    await documentInput('C 保留副本');await evaluate('window.__documentsFixture.rejectUnknown(13)');
    await wait("window.__documentsFixture.draft('workspace-a','new.txt').pendingMutation?.state === 'unknown'");
    await check('unknown file outcomes keep C and block fresh save or baseline replacement', "document.querySelector('[aria-label=文件正文]').value === 'C 保留副本' && Array.from(document.querySelectorAll('.workspace-document-actions button')).filter(button=>['保存文件','重新读取','重命名或移动','删除文件'].includes(button.textContent)).every(button=>button.disabled)");
    await documentButton('核对原操作');await wait('window.__documentsFixture.count() === 15');
    await check('file reconciliation sends the original identity and captured B command', "window.__documentsFixture.commandIds()[14] === window.__documentsFixture.commandIds()[13] && JSON.stringify(window.__documentsFixture.commands()[14]) === JSON.stringify(window.__documentsFixture.commands()[13]) && window.__documentsFixture.commands()[14].content === 'B 后续编辑'");
    await evaluate('window.__documentsFixture.resolveMutation(14)');
    await wait("!window.__documentsFixture.draft('workspace-a','new.txt').pendingMutation");
    await evaluate("window.__documentsFixture.restore('new.txt')");await wait('window.__documentsFixture.count() === 16');
    await evaluate("window.__documentsFixture.resolveRead(15,'EXTERNAL DISK EDIT')");
    await wait("document.querySelector('.file-draft-comparison') !== null");
    await check('restored conflicting drafts expose original, editing copy and current disk without writing', "Array.from(document.querySelectorAll('.file-draft-comparison pre')).map(e=>e.textContent).join('|') === 'B 后续编辑|C 保留副本|EXTERNAL DISK EDIT' && document.querySelector('[aria-label=文件正文]').value === 'C 保留副本' && Array.from(document.querySelectorAll('.workspace-document-actions button')).find(b=>b.textContent==='保存文件').disabled");
    await documentButton('复制草稿');await wait("window.__documentsFixture.copied().at(-1) === 'C 保留副本'");
    await check('copying a recovery copy uses private current text without a file mutation', 'window.__documentsFixture.count() === 16');
    await documentButton('重新核对磁盘');await wait('window.__documentsFixture.count() === 17');await evaluate('window.__documentsFixture.rejectMissing(16)');
    await wait("document.querySelector('.file-draft-recovery').textContent.includes('源文件已不存在')");
    await check('missing existing files remain copyable and are not silently recreated', "document.querySelector('[aria-label=文件正文]').value === 'C 保留副本' && !Array.from(document.querySelectorAll('.file-draft-recovery button')).some(b=>b.textContent==='创建此草稿文件') && window.__documentsFixture.count() === 17");
    await evaluate("window.__documentsFixture.select('unsaved-new.txt','workspace-a',true)");await wait("document.querySelector('[aria-label=文件正文]')?.value === ''");
    await documentInput('NEW RECOVERED COPY');await evaluate("window.__documentsFixture.restore('unsaved-new.txt')");
    await wait('window.__documentsFixture.count() === 18');await evaluate('window.__documentsFixture.rejectMissing(17)');
    await wait("Array.from(document.querySelectorAll('.file-draft-recovery button')).some(b=>b.textContent==='创建此草稿文件')");
    await documentButton('创建此草稿文件');await wait("document.querySelector('.action-dialog h2')?.textContent === '创建恢复文件'");
    await check('restored new-file creation requires an explicit confirmation', 'window.__documentsFixture.count() === 18');
    await confirmDocument();await wait('window.__documentsFixture.count() === 19');await evaluate('window.__documentsFixture.rejectMissing(18)');
    await wait('window.__documentsFixture.count() === 20');
    await check('explicit recovered new-file creation still uses create-if-absent', "window.__documentsFixture.commands()[19].kind === 'workspace.document.save' && window.__documentsFixture.commands()[19].expectedVersion === null");
    await evaluate('window.__documentsFixture.resolveMutation(19)');await wait("!window.__documentsFixture.draft('workspace-a','unsaved-new.txt').pendingMutation");
    await check('settled recovered creation clears the recovery banner and preserves text', "!document.querySelector('.file-draft-recovery') && document.querySelector('[aria-label=文件正文]').value === 'NEW RECOVERED COPY'");
    await evaluate('window.__documentsFixture.openSecondView()');
    await wait("window.__documentsFixture.secondView?.document.querySelector('[aria-label=文件正文]')?.value === 'NEW RECOVERED COPY'");
    await check('a second real Electron window uses the same editing owner without an extra read', 'window.__documentsFixture.count() === 20');
    await documentInput('WINDOW_A_CAPTURE');await documentButton('保存文件');await wait('window.__documentsFixture.count() === 21');
    await wait("window.__documentsFixture.secondView.document.querySelector('[aria-label=文件正文]').value === 'WINDOW_A_CAPTURE'");
    await evaluate("(() => {const child=window.__documentsFixture.secondView,input=child.document.querySelector('[aria-label=文件正文]');Object.getOwnPropertyDescriptor(child.HTMLTextAreaElement.prototype,'value').set.call(input,'WINDOW_B_NEWER');input.dispatchEvent(new child.Event('input',{bubbles:true}));})()");
    await wait("document.querySelector('[aria-label=文件正文]').value === 'WINDOW_B_NEWER'");
    await evaluate('window.__documentsFixture.resolveMutation(20)');
    await wait("!window.__documentsFixture.draft('workspace-a','unsaved-new.txt').pendingMutation");
    await check('A saved from one window preserves B typed in the other and updates both views', "document.querySelector('[aria-label=文件正文]').value === 'WINDOW_B_NEWER' && window.__documentsFixture.secondView.document.querySelector('[aria-label=文件正文]').value === 'WINDOW_B_NEWER' && window.__documentsFixture.draft('workspace-a','unsaved-new.txt').originalContent === 'WINDOW_A_CAPTURE'");
    await evaluate('window.__documentsFixture.closeSecondView()');
    await wait('!window.__documentsFixture.secondView');
    await check('closing the second view retains the shared unsaved draft', "document.querySelector('[aria-label=文件正文]').value === 'WINDOW_B_NEWER' && window.__documentsFixture.draft('workspace-a','unsaved-new.txt').content === 'WINDOW_B_NEWER'");
    if (documentsOnly) console.log('Scoped documents UI gate passed; other module gates were not run.');
    }
    if(memoryOnly)console.log('Scoped memory UI gate passed; fixtures do not verify production storage/model and other module gates were not run.');
    if(!documentsOnly&&!memoryOnly)await require('./smoke/task-center-ui.cjs')({window,wc,evaluate,wait,check,key,outputRoot:null});
    if(rendererErrors.length)throw new Error('Renderer errors prevent full UI acceptance: '+JSON.stringify(rendererErrors));
    window.destroy();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
