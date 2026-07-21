import { app } from 'electron';
import type {
  CapabilityStatus,
  GameActivitySnapshot,
  SystemCapability,
  UserPreferences
} from '@shared/contract';

export interface AutoLaunchService {
  getStatus(): Promise<CapabilityStatus>;
  setEnabled(enabled: boolean): Promise<void>;
}

export interface GameActivityDetector {
  getSnapshot(): Promise<GameActivitySnapshot>;
}

export class ElectronAutoLaunchService implements AutoLaunchService {
  async getStatus(): Promise<CapabilityStatus> {
    const supported = process.platform === 'win32' || process.platform === 'darwin';
    return {
      capability: 'auto-launch',
      availability: supported ? 'available' : 'unavailable',
      detail: supported ? 'Managed by Electron login item settings.' : 'Not implemented for this platform.'
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const status = await this.getStatus();
    if (status.availability !== 'available') throw new Error('Auto launch is unavailable on this platform.');
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}

export class UnavailableGameActivityDetector implements GameActivityDetector {
  async getSnapshot(): Promise<GameActivitySnapshot> {
    return {
      status: 'unknown',
      confidence: 0,
      reason: 'No platform game activity detector is installed in phase one.',
      observedAt: new Date().toISOString()
    };
  }
}

export class SystemCapabilityCatalog {
  constructor(
    private readonly autoLaunch: AutoLaunchService,
    private readonly gameActivity: GameActivityDetector
  ) {}

  async getStatuses(): Promise<CapabilityStatus[]> {
    const autoLaunch = await this.autoLaunch.getStatus();
    const statuses: Record<SystemCapability, CapabilityStatus> = {
      'auto-launch': autoLaunch,
      'wake.shortcut': unavailable('wake.shortcut', 'Global shortcut registration is reserved for a later phase.'),
      'wake.voice': unavailable('wake.voice', 'Voice wake is reserved for a later phase.'),
      'wake.system': unavailable('wake.system', 'System event wake adapters are reserved for a later phase.'),
      'window.attention': {
        capability: 'window.attention',
        availability: 'available',
        detail: 'Restore, focus and time-bounded topmost behavior are available.'
      },
      'game-activity': unavailable('game-activity', 'The phase-one detector reports unknown without guessing.')
    };
    return Object.values(statuses);
  }

  getGameActivity(): Promise<GameActivitySnapshot> {
    return this.gameActivity.getSnapshot();
  }

  async applyPreferences(previous: UserPreferences, next: UserPreferences): Promise<void> {
    if (previous.startAtLogin !== next.startAtLogin) {
      await this.autoLaunch.setEnabled(next.startAtLogin);
    }
  }
}

function unavailable(capability: SystemCapability, detail: string): CapabilityStatus {
  return { capability, availability: 'unavailable', detail };
}
