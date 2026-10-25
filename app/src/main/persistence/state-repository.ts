import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SavedLayout, UserPreferences } from '@shared/contract';
import { userPreferencesSchema } from '@shared/schemas';
import { persistedStateSchema, createDefaultState, parsePersistedState, type PersistedState } from './state-schema';
import { unrestrictedMainWrites, type MainWriteAdmission } from '../data-management/main-maintenance-gate';

export class StateRepository {
  private state: PersistedState = createDefaultState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly writes: MainWriteAdmission = unrestrictedMainWrites) {}

  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    try {
      this.state = parsePersistedState(JSON.parse(raw));
    } catch {
      await this.backupInvalidState();
      this.state = createDefaultState();
    }
  }

  getSnapshot(): PersistedState {
    return structuredClone(this.state);
  }

  validateBackup(raw: string): void { persistedStateSchema.parse(JSON.parse(raw)); }

  getLayout(): SavedLayout | null {
    return structuredClone(this.state.layout);
  }

  async saveLayout(layout: SavedLayout): Promise<void> {
    await this.update((state) => ({ ...state, layout }));
  }

  getPreferences(): UserPreferences {
    return structuredClone(this.state.preferences);
  }

  async savePreferences(preferences: UserPreferences): Promise<void> {
    await this.update((state) => ({ ...state, preferences: userPreferencesSchema.parse(preferences) }));
  }

  async saveWindowState(window: PersistedState['window']): Promise<void> {
    await this.writes.writeDeferred(() => this.update((state) => ({ ...state, window })));
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async update(mutator: (state: PersistedState) => PersistedState): Promise<void> {
    return this.writes.write(async () => {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const next = persistedStateSchema.parse(mutator(this.getSnapshot()));
        await this.writeSnapshot(next);
        this.state = next;
      });
    this.writeQueue = operation;
    await operation;
    });
  }

  private async writeSnapshot(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  private async backupInvalidState(): Promise<void> {
    try {
      const backupPath = `${this.filePath}.invalid-${Date.now()}`;
      await rename(this.filePath, backupPath);
      console.warn(`Invalid state was moved to ${backupPath}`);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new Error('Unable to preserve invalid application state before recovery.');
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
