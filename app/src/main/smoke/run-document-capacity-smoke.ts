import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installSmokeProjectionProbe } from './projection-probe';

export interface OversizedRunSmokeRecord {
  runId: string;
  sessionId: string;
  inputIds: string[];
  serializedInboxBytes: number;
  perItemUtf16Length: number;
  visibleCompleteBodies: boolean;
  restoredAfterRuntimeKills: boolean;
}

/** Uses the shipped bridge and verified bounded single-item reader after each
 * process/window boundary. Evidence keeps only identities/counts, not bodies. */
export async function verifyOversizedRunRecovery(window: BrowserWindow, workspaceId: string,
  outputRoot: string, phase: 'renderer-reload' | 'main-restart'): Promise<boolean> {
  const record = JSON.parse(await readFile(join(outputRoot, 'oversized-run-document.json'), 'utf8')) as OversizedRunSmokeRecord;
  if (record.inputIds.length !== 5 || record.serializedInboxBytes <= 1024 * 1024
    || record.perItemUtf16Length !== 96_000 || !record.visibleCompleteBodies || !record.restoredAfterRuntimeKills) {
    throw new Error('oversized_run_fixture_evidence_invalid');
  }
  if (phase === 'renderer-reload') {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('oversized_run_reload_timeout')), 15_000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    });
    window.webContents.reload(); await loaded; await installSmokeProjectionProbe(window);
  }
  const observed = await window.webContents.executeJavaScript(`(async () => {
    const record = ${JSON.stringify(record)}, deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await window.ariadne.runtime.getStatus();
      if (status.ok && status.value.availability === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const current = await window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)},
      { runCollections: { [record.runId]: ['inbox'] } });
    const run = current.runs.find(candidate => candidate.runId === record.runId);
    const content = '【模拟超大权威输入】汉字'.repeat(8000);
    const complete = run?.sessionId === record.sessionId && ['failed', 'cancelled'].includes(run.status)
      && run.inbox.length === 5 && record.inputIds.every(id => run.inbox.some(input => input.inputId === id
        && input.version === 1 && input.content === content && input.state === 'queued'));
    return { passed: complete, runId: record.runId, sessionId: record.sessionId,
      version: run?.version, status: run?.status, itemCount: run?.inbox.length,
      serializedInboxBytes: run ? new TextEncoder().encode(JSON.stringify(run.inbox)).length : 0,
      boundaries: current.boundaries };
  })()`, true) as { passed: boolean };
  await writeFile(join(outputRoot, `oversized-run-${phase}.json`), JSON.stringify({ phase, ...observed }, null, 2), 'utf8');
  return observed.passed;
}
