import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SavedLayout, UserPreferences } from '@shared/contract';
import { persistedStateSchema, createDefaultState, type PersistedState } from './state-schema';

export class StateRepository {
  private state: PersistedState = createDefaultState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = persistedStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return;
      await this.backupInvalidState();
      this.state = createDefaultState();
    }
  }

  getSnapshot(): PersistedState {
    return structuredClone(this.state);
  }

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
    await this.update((state) => ({ ...state, preferences }));
  }

  async saveWindowState(window: PersistedState['window']): Promise<void> {
    await this.update((state) => ({ ...state, window }));
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async update(mutator: (state: PersistedState) => PersistedState): Promise<void> {
    const next = persistedStateSchema.parse(mutator(this.getSnapshot()));
    this.state = next;
    this.writeQueue = this.writeQueue.then(() => this.writeSnapshot(next));
    await this.writeQueue;
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
      if (!isMissingFile(error)) console.warn('Unable to back up invalid application state', error);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
