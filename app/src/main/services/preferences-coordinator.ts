import type { UserPreferences } from '@shared/contract';

export interface PreferencesStateStore {
  getPreferences(): UserPreferences;
  savePreferences(preferences: UserPreferences): Promise<void>;
}

export interface PreferencesSideEffects {
  applyPreferences(previous: UserPreferences, next: UserPreferences): Promise<void>;
}

export class PreferencesCoordinator {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: PreferencesStateStore,
    private readonly sideEffects: PreferencesSideEffects
  ) {}

  update(next: UserPreferences): Promise<UserPreferences> {
    const result = this.operationQueue.then(() => this.applyUpdate(next));
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async flush(): Promise<void> {
    await this.operationQueue;
  }

  private async applyUpdate(next: UserPreferences): Promise<UserPreferences> {
    const previous = this.state.getPreferences();
    await this.sideEffects.applyPreferences(previous, next);
    try {
      await this.state.savePreferences(next);
      return this.state.getPreferences();
    } catch (originalError) {
      try {
        await this.sideEffects.applyPreferences(next, previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [originalError, rollbackError],
          '偏好设置保存失败，且恢复上一份系统设置时发生错误。'
        );
      }
      throw originalError;
    }
  }
}
