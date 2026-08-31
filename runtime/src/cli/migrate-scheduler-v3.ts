import { createHash } from 'node:crypto';
import path from 'node:path';

import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { SqliteConversationRunHandoffUnitOfWork } from '../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { SqliteProductivityStore } from '../adapters/persistence/SqliteProductivityStore.js';
import { createShutdownContext } from '../ingress/ShutdownContext.js';
import { LegacySchedulerJournalReader } from '../scheduler/LegacySchedulerJournalReader.js';

const options = parseOptions(process.argv.slice(2));
const journal = options.legacyJournal ?? path.join(options.dataRoot, 'scheduler', 'triggers.jsonl');
const legacy = new LegacySchedulerJournalReader(journal);
const conversation = new SqliteConversationRunHandoffUnitOfWork(options.dataRoot);
const productivity = new SqliteProductivityStore(options.dataRoot);
const context = createShutdownContext(Date.now() + 30_000);
let imported = 0;
let skipped = 0;
try {
  const session = await conversation.readSession(options.sessionId);
  if (session === null || session.workspaceId !== options.workspaceId) {
    throw new Error('scheduler_v3_migration_session_not_found');
  }
  for (const trigger of legacy.list()) {
    if (trigger.kind === 'event' || trigger.status === 'cancelled' || trigger.status === 'completed') {
      skipped += 1;
      continue;
    }
    const scheduleId = stableId('legacy-schedule', trigger.id);
    const timing = trigger.kind === 'once'
      ? { kind: 'once' as const, at: trigger.at, missPolicy: trigger.missPolicy ?? 'skip' as const }
      : trigger.kind === 'interval'
        ? { kind: 'interval' as const, intervalMs: trigger.intervalMs }
        : {
            kind: 'cron' as const, expression: trigger.cron,
            timezone: trigger.timezone ?? 'UTC',
            missPolicy: trigger.cronMissPolicy ?? 'skip' as const
          };
    const result = await productivity.execute(stableId('legacy-schedule-command', trigger.id), {
      kind: 'schedule.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      scheduleId,
      prompt: trigger.goal,
      timing
    });
    if (trigger.status === 'paused' && result.kind === 'schedule.updated.v3') {
      await productivity.execute(stableId('legacy-schedule-pause', trigger.id), {
        kind: 'schedule.transition.v3',
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        scheduleId,
        expectedVersion: result.schedule.version,
        action: 'pause'
      });
    }
    imported += 1;
  }
  process.stdout.write(`${JSON.stringify({ status: 'migrated', imported, skipped, source: journal })}\n`);
} finally {
  try { await productivity.close(context); } finally {
    try { await conversation.close(context); } finally { context.dispose(); }
  }
}

function parseOptions(args: string[]): {
  dataRoot: string; workspaceId: string; sessionId: string; legacyJournal?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) throw new Error('scheduler_v3_migration_arguments_invalid');
    values.set(key, value);
  }
  const dataRoot = values.get('--data-root');
  const workspaceId = values.get('--workspace-id');
  const sessionId = values.get('--session-id');
  if (!dataRoot || !path.isAbsolute(dataRoot) || !workspaceId || !sessionId) throw new Error('scheduler_v3_migration_arguments_invalid');
  const legacyJournal = values.get('--legacy-journal');
  if (legacyJournal !== undefined && !path.isAbsolute(legacyJournal)) throw new Error('scheduler_v3_migration_journal_invalid');
  return { dataRoot: path.resolve(dataRoot), workspaceId, sessionId, ...(legacyJournal === undefined ? {} : { legacyJournal: path.resolve(legacyJournal) }) };
}

function stableId(...parts: string[]): string {
  return `id-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`;
}
