const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(process.argv[2] ?? 'artifacts/renderer-history');
fs.mkdirSync(root, { recursive: true });
const log = value => fs.appendFileSync(path.join(root, 'renderer-performance-progress.log'), value + '\n');
log('main-started');
app.setPath('userData', path.join(root, 'renderer-performance-user-data'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  log('app-ready');
  let window;
  const timeout = setTimeout(() => { log('timeout'); app.exit(1); }, 120000);
  try {
    const measurements = [];
    for (const optimized of [false, true]) for (const count of [1000, 10000]) {
      window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      window.webContents.on('console-message', (_event, level, message) => log('console:' + level + ':' + message));
      window.webContents.on('render-process-gone', (_event, detail) => log(JSON.stringify(detail)));
      await window.loadFile(path.join(root, 'build/renderer-history.html'));
      window.setPosition(-10000, -10000, false);
      window.showInactive();
      log('start:' + count + ':' + optimized);
      const result = await window.webContents.executeJavaScript(`window.runHistoryBenchmark(${count}, ${optimized})`);
      result.rendererMemory = app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.memory;
      measurements.push(result);
      log('done:' + count + ':' + optimized);
      fs.writeFileSync(path.join(root, `renderer-performance-${count}-${optimized}.png`), (await window.webContents.capturePage()).toPNG());
      window.destroy();
      window = undefined;
    }
    fs.writeFileSync(path.join(root, 'renderer-performance.json'), JSON.stringify({ runId: process.argv[3],
      capturedAt: new Date().toISOString(), passed: measurements.length === 4 && measurements.every(item => item.liveVisible), cpu: os.cpus()[0].model,
      memoryGiB: os.totalmem() / 2 ** 30, versions: process.versions, measurements }, null, 2));
  } catch (error) { log(String(error)); console.error(error); process.exitCode = 1; }
  finally { clearTimeout(timeout); window?.destroy(); app.quit(); }
});
