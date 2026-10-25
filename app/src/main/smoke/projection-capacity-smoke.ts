import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { showSmokeWindow } from './window-visibility';
import { projectionCapacityMetrics, projectionCapacityStartupElapsedMs, projectionCapacityLifecycle } from './projection-capacity-metrics';

const helpers = `
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (probe, label) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(100); }
  throw new Error('capacity_wait_timeout:' + label);
};
const request = async command => {
  const result = await window.ariadne.runtime.request(command);
  if (!result.ok) throw new Error('capacity_request_failed:' + JSON.stringify(result.error));
  return result.value;
};
const sessionButton = id => document.querySelector('.conversation-row[data-session-id="' + id + '"] .conversation-row-main');
const header = () => document.querySelector('.chat-heading h1')?.textContent ?? '';
const nodes = () => document.querySelectorAll('[data-conversation-node]');
const clickText = (root, text) => {
  const button = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === text);
  if (!button || button.disabled) throw new Error('capacity_button_unavailable:' + text);
  button.click();
};
const heap = () => performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize,
  limit: performance.memory.jsHeapSizeLimit } : null;
`;

/** Exercises the shipped UI and public bridge against a separately seeded authority. */
export async function verifyProjectionCapacityWindow(window: BrowserWindow, outputRoot: string): Promise<boolean> {
  await mkdir(outputRoot, { recursive: true });
  const workspaceId = process.env.ARIADNE_SMOKE_WORKSPACE_ID;
  if (!workspaceId) throw new Error('capacity_workspace_missing');
  const phase = process.env.ARIADNE_SMOKE_CAPACITY_PHASE ?? 'initial';
  const baseline = phase === 'baseline';
  const started = performance.now(), consoleErrors: string[] = [];
  const onConsole = (_event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>, level: number, message: string): void => {
    if (level === 3 && consoleErrors.length < 32) consoleErrors.push(message.slice(0, 512));
  };
  window.webContents.on('console-message', onConsole);
  showSmokeWindow(window);
  const observations: Record<string, unknown> = {}, samples: Record<string, unknown>[] = [];
  const run = async (name: string, source: string): Promise<unknown> => {
    const before = performance.now();
    const result: unknown = await window.webContents.executeJavaScript(`(async () => { ${helpers} ${source} })()`);
    observations[name] = { result, durationMs: performance.now() - before };
    samples.push({ name, elapsedMs: performance.now() - started, processes: app.getAppMetrics().map(metric => ({
      pid: metric.pid, type: metric.type, memory: metric.memory, cpu: metric.cpu
    })) });
    return result;
  };
  let fatalError: string | null = null;
  let startupMs: number | null = null;
  let runtimeKillBoundaryMs: number | null = null;
  try {
    await run('ready', `
      await wait(() => document.querySelector('.chat-panel[aria-busy="false"]'), 'models_read_ready');
      const selector = '.conversation-workspace-row[data-workspace-id="' + ${JSON.stringify(workspaceId)} + '"] .conversation-workspace-main';
      const workspace = await wait(() => document.querySelector(selector), 'workspace'); workspace.click();
      await wait(() => document.querySelector('[aria-label="会话分页"]')?.textContent.includes(${JSON.stringify(baseline ? '0 项' : '150 项')}), 'session_directory');
      return { directoryRows: document.querySelectorAll('.conversation-row[data-session-id]').length, heap: heap() };
    `);
    startupMs = projectionCapacityStartupElapsedMs();
    if (!baseline) {
    await run('directoryAndHistory', `
      const pager = document.querySelector('[aria-label="会话分页"]');
      if (document.querySelectorAll('.conversation-row[data-session-id]').length !== 128) throw new Error('capacity_first_page_size');
      clickText(pager, '下一页');
      await wait(() => document.querySelector('[aria-label="会话分页"]')?.textContent.includes('第 2 页'), 'second_directory_page');
      const button = await wait(() => sessionButton('capacity-session-149'), 'offpage_session'); button.click();
      await wait(() => header().includes('Session 149') && nodes().length === 64, 'latest_history');
      if (document.getElementById('chat-node-capacity-user-149-00')) throw new Error('capacity_latest_contains_old_anchor');
      clickText(document.querySelector('.message-list'), '查看更早的消息');
      await wait(() => nodes().length === 36 && document.getElementById('chat-node-capacity-user-149-00'), 'older_history');
      clickText(document.querySelector('.message-list'), '返回最新消息');
      await wait(() => nodes().length === 64 && !document.getElementById('chat-node-capacity-user-149-00'), 'latest_history_return');
      clickText(document.querySelector('[aria-label="会话分页"]'), '上一页');
      await wait(() => document.querySelector('[aria-label="会话分页"]')?.textContent.includes('第 1 页'), 'first_directory_return');
      sessionButton('capacity-session-050').click();
      await wait(() => header().includes('Session 050') && document.getElementById('chat-node-capacity-user-50-49'), 'leave_selected_offpage_detail');
      return { latestCount: nodes().length, directoryCount: document.querySelectorAll('.conversation-row[data-session-id]').length, heap: heap() };
    `);
    await run('searchOutsideDirectory', `
      if (sessionButton('capacity-session-149')) throw new Error('capacity_search_session_not_offpage');
      const input = document.querySelector('input[aria-label="搜索会话"]');
      if (!input) throw new Error('capacity_search_input_missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'CAPACITY_ANCHOR_149');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const result = await wait(() => document.querySelector('.conversation-search-result[data-session-id="capacity-session-149"]'), 'search_result'); result.click();
      const anchor = await wait(() => document.getElementById('chat-node-capacity-user-149-00'), 'search_around_anchor');
      await wait(() => nodes().length === 64, 'search_window_size');
      await delay(300);
      const viewport = document.querySelector('.message-viewport'), bounds = anchor.getBoundingClientRect(), visible = viewport.getBoundingClientRect();
      const anchorIntersectsViewport = bounds.top < visible.bottom && bounds.bottom > visible.top;
      if (!anchorIntersectsViewport) throw new Error('capacity_search_anchor_not_visible');
      await wait(() => anchor.textContent.includes('CAPACITY_ANCHOR_149'), 'search_anchor_body');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(() => sessionButton('capacity-session-050'), 'search_cleared');
      return { messageCount: nodes().length, anchorIntersectsViewport, anchorBodyRead: true, heap: heap() };
    `);
    await run('switchPressure', `
      const samples = [];
      for (let index = 50; index < 74; index++) {
        const id = 'capacity-session-' + String(index).padStart(3, '0');
        const button = await wait(() => sessionButton(id), 'switch_directory_' + index); button.click();
        await wait(() => header().includes('Session ' + String(index).padStart(3, '0')) && nodes().length === 64
          && document.getElementById('chat-node-capacity-user-' + index + '-49'), 'switch_history_' + index);
        samples.push({ sessionId: id, nodeCount: nodes().length, domNodes: document.getElementsByTagName('*').length, heap: heap() });
      }
      return samples;
    `);
    await run('concurrentWritesFixedBoundary', `
      const begin = () => request({ kind: 'projection.catalog.begin', request: { pageContractVersion: '3.0',
        scope: { kind: 'directory' }, feature: 'sessions', filter: 'all' } });
      const old = (await begin()).manifest;
      const first = (await request({ kind: 'projection.catalog.page', request: { manifest: old, limit: 128 } })).page;
      if (first.status !== 'ok' || !first.nextPageCursor || first.totalRows !== 150) throw new Error('capacity_pinned_first_page');
      for (let index = 0; index < 10; index++) {
        const fresh = (await begin()).manifest;
        const detail = (await request({ kind: 'projection.catalog.detail', request: { manifest: fresh, aggregateId: 'capacity-session-101' } })).detail;
        const version = detail.change.dto.version;
        await request({ kind: 'conversation.session.rename', contractVersion: '5.0', sessionId: 'capacity-session-101',
          workspaceId: ${JSON.stringify(workspaceId)}, expectedSessionVersion: version, title: '【模拟容量数据】持续写入 ' + ${JSON.stringify(phase)} + '-' + index });
        await wait(async () => {
          const manifest = (await begin()).manifest;
          const current = (await request({ kind: 'projection.catalog.detail', request: { manifest, aggregateId: 'capacity-session-101' } })).detail;
          return current.change?.dto.version === version + 1;
        }, 'rename_projection_' + index);
      }
      const second = (await request({ kind: 'projection.catalog.page', request: { manifest: old, limit: 128, pageCursor: first.nextPageCursor } })).page;
      if (second.status !== 'ok' || second.totalRows !== 150 || second.rows.length !== 22
        || second.manifest.boundaryCursor !== old.boundaryCursor) throw new Error('capacity_fixed_boundary_changed');
      return { firstRows: first.rows.length, secondRows: second.rows.length, boundaryCursor: old.boundaryCursor, writes: 10, heap: heap() };
    `);
    if (phase === 'initial') {
      runtimeKillBoundaryMs = projectionCapacityStartupElapsedMs();
      await writeFile(join(outputRoot, 'runtime-kill.ready'), JSON.stringify({ mainPid: process.pid }));
      await run('runtimeRecovery', `
        await wait(async () => (await window.ariadne.runtime.getStatus()).value?.availability !== 'ready', 'runtime_killed');
        await wait(async () => (await window.ariadne.runtime.getStatus()).value?.availability === 'ready', 'runtime_restarted');
        await wait(() => document.querySelector('.chat-panel[aria-busy="false"]') && nodes().length === 64, 'projection_recovered');
        return { messages: nodes().length, heap: heap() };
      `);
    }
    }
  } catch (error) { fatalError = error instanceof Error ? error.message : String(error); }
  finally { window.webContents.removeListener('console-message', onConsole); }
  const metrics = projectionCapacityMetrics();
  const scalarQueriesAbsent = !metrics['projection.snapshot.get'] && !metrics['projection.commits.read'];
  const boundedResponses = Object.entries(metrics).filter(([kind]) => kind.startsWith('projection.'))
    .every(([, metric]) => metric.responseBytesMax <= 2 * 1024 * 1024);
  const runtimeLifecycle = projectionCapacityLifecycle();
  const crashes = runtimeLifecycle.filter(value => value.availability === 'crashed');
  const unexpectedRuntimeCrash = crashes.some(value => runtimeKillBoundaryMs === null || value.elapsedMs < runtimeKillBoundaryMs)
    || crashes.length > (phase === 'initial' ? 1 : 0) || runtimeLifecycle.some(value => value.handshakeTimedOut);
  const passed = fatalError === null && consoleErrors.length === 0 && scalarQueriesAbsent && boundedResponses && !unexpectedRuntimeCrash;
  const screenshot = join(outputRoot, `capacity-${phase}.png`);
  await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  await writeFile(join(outputRoot, `capacity-${phase}.json`), JSON.stringify({ format: 'ariadne-electron-projection-capacity.v1',
    passed, phase, mainPid: process.pid, startupMs, durationMs: performance.now() - started, fatalError, consoleErrors,
    scalarQueriesAbsent, boundedResponses, unexpectedRuntimeCrash, runtimeKillBoundaryMs, metrics, runtimeLifecycle, observations, samples, screenshot,
    completedAt: new Date().toISOString() }, null, 2));
  return passed;
}
