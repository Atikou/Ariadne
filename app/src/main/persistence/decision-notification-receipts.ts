import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';
import type { DecisionNotificationItem, DecisionNotificationReference } from '../services/decision-notification-source';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';

const MAX_RECEIPTS = 2048;
export const NOTIFICATION_REMINDER_MS = 30 * 60_000;
const receiptSchema = z.object({ decisionId: publicProjectionCanonicalIdSchema, sessionId: publicProjectionCanonicalIdSchema,
  runId: publicProjectionCanonicalIdSchema, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), shownAt: z.string().datetime() }).strict();
const fileSchema = z.object({ format: z.literal('ariadne-decision-notifications.v1'), receipts: z.array(receiptSchema).max(MAX_RECEIPTS) }).strict()
  .refine(value => new Set(value.receipts.map(row => row.decisionId)).size === value.receipts.length);
type Receipt = z.infer<typeof receiptSchema>;
export interface DecisionNotificationReceipts {
  references(): readonly DecisionNotificationReference[];
  shouldNotify(item: DecisionNotificationItem): boolean;
  recordShown(item: DecisionNotificationItem): Promise<void>;
  retainPending(ids: ReadonlySet<string>): Promise<void>;
  flush(): Promise<void>;
}

/** Main-owned display receipts, never business state. Native show events alone
 * establish delivery; failed/unknown attempts leave pending Decisions eligible.
 * A finite reminder interval prevents a persisted receipt hiding work forever. */
export class FileDecisionNotificationReceipts implements DecisionNotificationReceipts {
  private receipts = new Map<string, Receipt>();
  private queue: Promise<void> = Promise.resolve();
  private persistenceAvailable = true;
  constructor(private readonly filePath: string, private readonly now: () => number = Date.now,
    private readonly writes: MainWriteAdmission = unrestrictedMainWrites) {}
  async initialize(): Promise<void> {
    let raw: string;
    try {
      if ((await stat(this.filePath)).size > 2 * 1024 * 1024) throw new Error('notification_receipts_invalid');
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) { if (isMissing(error)) return;
      if (error instanceof Error && error.message === 'notification_receipts_invalid') {
        try { await this.preserveInvalid(); } catch { this.disablePersistence(); }
      } else this.disablePersistence();
      return; }
    try { const parsed = fileSchema.parse(JSON.parse(raw)); this.receipts = new Map(parsed.receipts.map(row => [row.decisionId, row])); }
    catch { try { await this.preserveInvalid(); } catch { this.disablePersistence(); } }
  }
  references(): readonly DecisionNotificationReference[] {
    return [...this.receipts.values()].map(({decisionId, sessionId, runId, version}) => ({decisionId, sessionId, runId, version}));
  }
  shouldNotify(item: DecisionNotificationItem): boolean {
    const previous = this.receipts.get(item.decisionId);
    if (!previous || previous.sessionId !== item.sessionId || previous.runId !== item.runId || previous.version !== item.version) return true;
    const elapsed = this.now() - Date.parse(previous.shownAt);
    return elapsed < 0 || elapsed >= NOTIFICATION_REMINDER_MS;
  }
  recordShown(item: DecisionNotificationItem): Promise<void> {
    const row = receiptSchema.parse({ decisionId: item.decisionId, sessionId: item.sessionId, runId: item.runId,
      version: item.version, shownAt: new Date(this.now()).toISOString() });
    return this.update(next => {
      const previous = next.get(row.decisionId);
      if (previous && previous.sessionId === row.sessionId && previous.runId === row.runId && previous.version > row.version) return false;
      next.set(row.decisionId, row);
      if (next.size > MAX_RECEIPTS) {
        const oldest = [...next.values()].sort((a, b) => a.shownAt.localeCompare(b.shownAt) || a.decisionId.localeCompare(b.decisionId));
        for (const removed of oldest.slice(0, next.size - MAX_RECEIPTS)) next.delete(removed.decisionId);
      }
      return true;
    });
  }
  retainPending(ids: ReadonlySet<string>): Promise<void> {
    const retained = new Set(ids);
    return this.update(next => { let changed = false;
      for (const id of next.keys()) if (!retained.has(id)) { next.delete(id); changed = true; }
      return changed; });
  }
  flush(): Promise<void> { return this.queue; }
  validateBackup(raw: string): void { fileSchema.parse(JSON.parse(raw)); }
  private update(change: (next: Map<string, Receipt>) => boolean): Promise<void> {
    return this.writes.write(async () => {
    const task = this.queue.catch(() => undefined).then(async () => {
      const next = new Map(this.receipts); if (!change(next)) return;
      const snapshot = fileSchema.parse({ format: 'ariadne-decision-notifications.v1', receipts: [...next.values()] });
      if (this.persistenceAvailable) {
        try {
          await mkdir(dirname(this.filePath), { recursive: true });
          const temporary = `${this.filePath}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot) + '\n', { encoding: 'utf8', mode: 0o600 });
          await rename(temporary, this.filePath);
        } catch { this.disablePersistence(); }
      }
      // These are observed native display receipts, not command outcomes.
      // Keep their in-process deduplication when optional disk metadata fails;
      // never overwrite an unreadable original or stop the business Runtime.
      this.receipts = next;
    });
    this.queue = task; return task;
    });
  }
  private async preserveInvalid(): Promise<void> {
    await rename(this.filePath, `${this.filePath}.invalid-${randomUUID()}`);
    console.warn('Invalid notification display receipts were preserved; pending Decisions will be read again.');
  }
  private disablePersistence(): void {
    if (!this.persistenceAvailable) return;
    this.persistenceAvailable = false;
    console.warn('Notification display receipt storage is unavailable; existing files are retained and this process uses observed display receipts.');
  }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
