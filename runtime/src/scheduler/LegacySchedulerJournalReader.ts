import { existsSync, readFileSync } from 'node:fs';

import { TriggerJournalLineSchema, type TriggerRecord } from './types.js';

/** Read-only decoder for explicit offline migration of the retired JSONL scheduler. */
export class LegacySchedulerJournalReader {
  public constructor(private readonly journalFile: string) {}

  public list(): readonly TriggerRecord[] {
    const triggers = new Map<string, TriggerRecord>();
    if (!existsSync(this.journalFile)) return [];
    for (const line of readFileSync(this.journalFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(trimmed); } catch { continue; }
      const result = TriggerJournalLineSchema.safeParse(decoded);
      if (!result.success) continue;
      if (result.data.op === 'delete') triggers.delete(result.data.id);
      else triggers.set(result.data.trigger.id, result.data.trigger);
    }
    return [...triggers.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((trigger) => structuredClone(trigger));
  }
}
