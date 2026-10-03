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
      define: { 'process.env.NODE_ENV': '"production"' }
    });
    writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Ariadne UI fixture</title><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    copyFileSync(resolve(__dirname, '../app/src/renderer/public/popout.html'), join(directory, 'popout.html'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, directory, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
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
    const window = new BrowserWindow({ width: 1000, height: 600, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const wc = window.webContents;
    wc.on('console-message', details => { if (details.message?.includes('dockview')) console.log('DOCKVIEW', details.message); });
    const evaluate = code => wc.executeJavaScript(code);
    const wait = async expression => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const state = await evaluate("JSON.stringify({ focused: document.activeElement?.outerHTML?.slice(0, 500), dialogs: document.querySelectorAll('dialog').length, opened: window.__uiFixture?.opened })");
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
    window.show();
    window.focus();
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
    if (process.argv.includes('--capture')) {
      const directory = mkdtempSync(join(tmpdir(), 'ariadne-tabs-layout-'));
      writeFileSync(join(directory, 'light-tabs.png'), (await wc.capturePage()).toPNG());
      console.log(`TABS_LAYOUT_ARTIFACTS ${directory}`);
    }
    window.destroy();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
