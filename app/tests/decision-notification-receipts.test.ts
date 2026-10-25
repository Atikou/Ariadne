import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDecisionNotificationReceipts, NOTIFICATION_REMINDER_MS } from '../src/main/persistence/decision-notification-receipts';

const roots: string[] = [];
const item = { decisionId: 'decision-1', sessionId: 'session-1', runId: 'run-1', version: 1,
  kind: 'permission' as const, status: 'pending' as const, title: 'PRIVATE_TITLE_NOT_PERSISTED' };
afterEach(async () => { for (const root of roots.splice(0)) {
  const scoped = relative(resolve(tmpdir()), resolve(root));
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || !basename(root).startsWith('ariadne-notification-receipts-'))
    throw new Error('notification_receipts_test_cleanup_outside_temp');
  await rm(root, { recursive: true, force: true });
} });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'ariadne-notification-receipts-')); roots.push(root);
  return { root, file: join(root, 'receipts.json') }; }
describe('native notification display receipts', () => {
  it('keeps only minimum identity after atomic close/reopen and reminds after a finite interval', async () => {
    const { file } = await fixture(); let now = Date.parse('2032-01-01T00:00:00.000Z');
    const first = new FileDecisionNotificationReceipts(file, () => now); await first.initialize();
    expect(first.shouldNotify(item)).toBe(true); await first.recordShown(item); await first.flush();
    const next = new FileDecisionNotificationReceipts(file, () => now); await next.initialize();
    expect(next.shouldNotify(item)).toBe(false); expect(next.shouldNotify({ ...item, version: 2 })).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain(item.title);
    expect(JSON.parse(await readFile(file, 'utf8')).receipts[0]).toEqual({ decisionId: item.decisionId, sessionId: item.sessionId,
      runId: item.runId, version: 1, shownAt: '2032-01-01T00:00:00.000Z' });
    now += NOTIFICATION_REMINDER_MS; expect(next.shouldNotify(item)).toBe(true);
  });
  it('serializes shown/settlement writes and refuses to overwrite a newer shown version with an old event', async () => {
    const { file } = await fixture(); const receipts = new FileDecisionNotificationReceipts(file); await receipts.initialize();
    await Promise.all([receipts.recordShown({ ...item, version: 2 }), receipts.recordShown(item)]);
    const next = new FileDecisionNotificationReceipts(file); await next.initialize();
    expect(next.shouldNotify({ ...item, version: 2 })).toBe(false);
    await receipts.retainPending(new Set()); await receipts.flush();
    const settled = new FileDecisionNotificationReceipts(file); await settled.initialize(); expect(settled.shouldNotify(item)).toBe(true);
  });
  it('preserves malformed display metadata instead of accepting it as proof of delivery', async () => {
    const { root, file } = await fixture(); const invalid = '{"private":"ORIGINAL_BAD_RECEIPT"}'; await writeFile(file, invalid);
    const receipts = new FileDecisionNotificationReceipts(file); await receipts.initialize();
    expect(receipts.shouldNotify(item)).toBe(true);
    const preserved = (await readdir(root)).find(name => name.startsWith('receipts.json.invalid-')); expect(preserved).toBeTruthy();
    expect(await readFile(join(root, preserved!), 'utf8')).toBe(invalid);
  });
  it('retains an unreadable source and deduplicates actual display within this process without blocking startup or flush', async () => {
    const { file } = await fixture(); await mkdir(file); await writeFile(join(file, 'retained.txt'), 'ORIGINAL_DISPLAY_SOURCE');
    const receipts = new FileDecisionNotificationReceipts(file); await receipts.initialize();
    expect(receipts.shouldNotify(item)).toBe(true); await receipts.recordShown(item); await receipts.flush();
    expect(receipts.shouldNotify(item)).toBe(false);
    expect(await readFile(join(file, 'retained.txt'), 'utf8')).toBe('ORIGINAL_DISPLAY_SOURCE');
    const reopened = new FileDecisionNotificationReceipts(file); await reopened.initialize();
    expect(reopened.shouldNotify(item)).toBe(true); // No disk proof was fabricated.
  });
});
