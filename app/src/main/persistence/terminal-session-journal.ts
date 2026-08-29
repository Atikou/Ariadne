import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

import type { TerminalRecoveryRecord, TerminalShell } from '@shared/contract';

const terminalRecordSchema = z.object({
  sessionId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(128),
  shell: z.enum(['powershell', 'cmd']),
  status: z.enum(['running', 'completed', 'failed', 'killed', 'interrupted']),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  restartOf: z.string().uuid().optional(),
  exitCode: z.number().int().optional(),
  detail: z.string().max(4_096).optional()
}).strict();

const terminalJournalSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(terminalRecordSchema).max(100)
}).strict();

type TerminalRecord = z.infer<typeof terminalRecordSchema>;
type TerminalJournal = z.infer<typeof terminalJournalSchema>;

/**
 * Main-owned terminal lifecycle facts. PTY output and commands are deliberately
 * excluded: after a Main crash Ariadne can report the interrupted session and
 * offer an explicit restart without replaying potentially destructive input.
 */
export class TerminalSessionJournal {
  private journal: TerminalJournal = { schemaVersion: 1, records: [] };
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.journal = terminalJournalSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (!isMissingFile(error)) throw new Error('terminal_session_journal_invalid', { cause: error });
      await this.persist(this.journal);
    }
    const recoveredAt = this.now().toISOString();
    const recovered = this.journal.records.map((record) => record.status === 'running'
      ? { ...record, status: 'interrupted' as const, updatedAt: recoveredAt, detail: 'main_process_lost' }
      : record);
    if (recovered.some((record, index) => record !== this.journal.records[index])) {
      this.journal = terminalJournalSchema.parse({ ...this.journal, records: recovered });
      await this.persist(this.journal);
    }
    this.initialized = true;
  }

  public list(): TerminalRecoveryRecord[] {
    this.assertInitialized();
    return structuredClone([...this.journal.records].sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || right.sessionId.localeCompare(left.sessionId)
    )));
  }

  public async start(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly shell: TerminalShell;
    readonly restartOf?: string;
  }): Promise<TerminalRecoveryRecord> {
    const timestamp = this.now().toISOString();
    const record = terminalRecordSchema.parse({
      ...input,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp
    });
    await this.mutate((current) => {
      if (current.records.some((candidate) => candidate.sessionId === record.sessionId)) {
        throw new Error('terminal_session_journal_identity_conflict');
      }
      if (record.restartOf !== undefined && !current.records.some((candidate) => (
        candidate.sessionId === record.restartOf
        && candidate.workspaceId === record.workspaceId
        && candidate.shell === record.shell
        && candidate.status !== 'running'
      ))) throw new Error('terminal_session_restart_source_invalid');
      return [...current.records.slice(-99), record];
    });
    return structuredClone(record);
  }

  public async finish(
    sessionId: string,
    outcome: Pick<TerminalRecord, 'status'> & Pick<TerminalRecord, 'exitCode' | 'detail'>
  ): Promise<void> {
    if (outcome.status === 'running') throw new Error('terminal_session_terminal_status_required');
    await this.mutate((current) => current.records.map((record) => record.sessionId === sessionId
      ? terminalRecordSchema.parse({
          ...record,
          status: outcome.status,
          updatedAt: this.now().toISOString(),
          ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail })
        })
      : record));
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async mutate(operation: (current: TerminalJournal) => TerminalRecord[]): Promise<void> {
    this.assertInitialized();
    const queued = this.writeQueue.then(async () => {
      const next = terminalJournalSchema.parse({
        schemaVersion: 1,
        records: operation(this.journal)
      });
      await this.persist(next);
      this.journal = next;
    });
    this.writeQueue = queued;
    await queued;
  }

  private async persist(journal: TerminalJournal): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('terminal_session_journal_not_initialized');
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
