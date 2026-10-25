const { join, resolve, isAbsolute } = require('node:path');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
if (!process.versions.electron) {
  const output = process.argv[2]; if (!output || !isAbsolute(output)) throw new Error('absolute_task_ui_evidence_required');
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(tmpdir(), 'AriadneTaskIsolationUI-'));
  require('esbuild').buildSync({ absWorkingDir: resolve(__dirname, '..'), entryPoints: ['app/tests/renderer-task-isolation.fixture.tsx'],
    outfile: join(directory, 'fixture.js'), tsconfig: 'app/tsconfig.web.json', bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Task isolation UI fixture</title><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, directory, output],
    { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const output = process.argv[3]; app.setPath('userData', join(process.argv[2], 'profile'));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 340, height: 760, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true } });
    const evaluate = code => window.webContents.executeJavaScript(code), checks = [];
    const wait = async condition => { const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { if (await evaluate(condition)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Task UI timeout: ' + condition); };
    const check = async (name, condition) => { if (!await evaluate(condition)) throw new Error('Task UI failed: ' + name);
      checks.push(name); console.log('PASS ' + name); };
    await window.loadFile(join(process.argv[2], 'index.html'));
    await wait('window.__taskIsolationFixture?.queries.length===1');
    await evaluate("window.__taskIsolationFixture.select('fixture-b')");
    await wait('window.__taskIsolationFixture.queries.length===2');
    await evaluate('window.__taskIsolationFixture.resolveQuery(1)');
    await wait("!!document.querySelector('[data-task-fault-id=fixture-fault-fixture-b]')");
    await evaluate('window.__taskIsolationFixture.resolveQuery(0)');
    await check('late pages cannot replace another session', "!document.querySelector('[data-task-fault-id=fixture-fault-fixture-a]')");
    await evaluate("(()=>{const b=[...document.querySelectorAll('.productivity-task-faults button')].find(b=>b.textContent==='核对并恢复');b.click();b.click()})()");
    await wait('window.__taskIsolationFixture.recoveries.length===1');
    await check('rapid recovery clicks are single flight', "window.__taskIsolationFixture.recoveries[0].command.sessionId==='fixture-b' && document.querySelector('[data-task-fault-id=fixture-fault-fixture-b] button').disabled");
    await evaluate("window.__taskIsolationFixture.select('fixture-a')");
    await wait('window.__taskIsolationFixture.queries.length===3');
    await evaluate('window.__taskIsolationFixture.resolveQuery(2);window.__taskIsolationFixture.resolveRecovery(0)');
    await wait("!!document.querySelector('[data-task-fault-id=fixture-fault-fixture-a]')");
    await check('a stale recovery cannot publish success into another session', "!document.querySelector('.productivity-task-faults [role=status]')?.textContent.includes('可以继续处理') && window.__taskIsolationFixture.queries.length===3");
    await evaluate("[...document.querySelectorAll('.productivity-task-faults button')].find(b=>b.textContent==='核对并恢复').click()");
    await wait('window.__taskIsolationFixture.recoveries.length===2');
    await evaluate('window.__taskIsolationFixture.resolveRecovery(1,true)');
    await wait("!!document.querySelector('.productivity-task-faults [role=alert]')");
    await check('unknown outcome stays visible without leaking exception payloads', "document.body.textContent.includes('原命令身份') && !document.body.textContent.includes('PRIVATE_UI_GATEWAY_PAYLOAD')");
    await evaluate("[...document.querySelectorAll('.productivity-task-faults button')].find(b=>b.textContent==='核对并恢复').click()");
    await wait('window.__taskIsolationFixture.recoveries.length===3');
    await check('explicit retry preserves the original recovery identity', 'window.__taskIsolationFixture.recoveries[1].commandId===window.__taskIsolationFixture.recoveries[2].commandId');
    await evaluate('window.__taskIsolationFixture.resolveRecovery(2)');
    await wait('window.__taskIsolationFixture.queries.length===4');
    await evaluate('window.__taskIsolationFixture.resolveQuery(3,true)');
    await wait("document.querySelector('[data-task-fault-id=fixture-fault-fixture-a]')?.textContent.includes('已恢复')");
    await check('only confirmed recovery disables another recovery attempt', "document.querySelector('[data-task-fault-id=fixture-fault-fixture-a] button').disabled && document.body.textContent.includes('可以继续处理')");
    await evaluate("[...document.querySelectorAll('.productivity-task-faults button')].find(b=>b.textContent==='打开所属会话').click()");
    await wait('window.__taskIsolationFixture.selected.length===1');
    await check('navigation uses the child task session', "window.__taskIsolationFixture.selected[0]==='fixture-child-fixture-a'");
    await check('long task IDs fit a narrow panel and leave no unhandled rejection', 'document.documentElement.scrollWidth<=innerWidth && window.__taskIsolationFixture.unhandled.length===0');
    writeFileSync(join(output, 'task-isolation-ui.png'), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(output, 'gate.json'), JSON.stringify({ passed: true, evidence: 'explicit_deferred_ui_fixture', width: 340, checks }, null, 2));
    window.destroy(); app.exit(0);
  }).catch(error => { writeFileSync(join(output, 'failure.json'), JSON.stringify({ passed: false, error: error.message }, null, 2)); console.error(error); app.exit(1); });
}
