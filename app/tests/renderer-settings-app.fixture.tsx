// Full App and module service scoping with isolated services; no user data is accessed.
import { StrictMode } from 'react';
import { App } from '../src/renderer/src/app/App';
import { ModuleRegistry } from '../src/renderer/src/core/modules/module-registry';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { settingsModule } from '../src/renderer/src/modules/settings';
import { settingsModels, settingsModelControls } from './renderer-settings-models.fixture';

const registry = new ModuleRegistry([{ ...settingsModule, defaultPlacement: {} }]);
let diagnostics = { status: { availability: 'ready', observedAt: new Date().toISOString() }, domainHealth: { state: 'ready', health: null } };
const diagnosticListeners = new Set<() => void>();
const events = { subscribe: () => () => {}, emit: () => {} };
const fixture = { failContent: false, failPreferences: false, caughtErrors: 0, loads: 0, saves: [] as unknown[], preferenceWrites: [] as unknown[],
  pulse: () => { diagnostics = { ...diagnostics }; diagnosticListeners.forEach(listener => listener()); } };
const failureMessage = 'SETTINGS_FIXTURE_CONTENT_FAILURE';
const reportError = console.error;
console.error = (...args: unknown[]) => {
  // Only the explicitly injected boundary failure is expected; report all other errors.
  if (args.some(value => value instanceof Error && value.message === failureMessage)) {
    fixture.caughtErrors++;
    return;
  }
  reportError(...args);
};
Object.assign(window, { __settingsAppFixture: fixture, __settingsModelFixture: settingsModelControls });

export function SettingsAppFixture({ services }: { services: ModuleServices }) {
  window.ariadne = { layout: { load: async () => null, save: async () => {} },
    window: { setTitleBarTheme: async () => {} } } as unknown as typeof window.ariadne;
  const scoped = { ...services, events, models: settingsModels,
    agentSettings: { ...services.agentSettings, load: async () => { fixture.loads++; return services.agentSettings.load(); },
      apply: async (request: { operations: Array<{ kind: string; assistant?: unknown; disabledModelIds?: string[] }> }) => {
        fixture.saves.push(request);
        const baseline = await services.agentSettings.load();
        return { ok: true, effect: 'hot_applied', settings: { ...baseline, revision: baseline.revision + 1,
          assistant: request.operations.find(operation => operation.kind === 'assistant.replace')?.assistant ?? baseline.assistant,
          disabledLocalModelIds: request.operations.find(operation => operation.kind === 'localModels.replace')?.disabledModelIds ?? baseline.disabledLocalModelIds } };
      } },
    speech: { ...services.speech, getSnapshot: () => {
      if (fixture.failContent) throw new Error(failureMessage);
      return services.speech.getSnapshot();
    } },
    preferences: { ...services.preferences, update: async (next: unknown) => {
      fixture.preferenceWrites.push(next);
      if (fixture.failPreferences) throw new Error('FIXTURE_PREFERENCE_SAVE_FAILED');
      return next;
    } },
    dataManagement: { measureUsage: async () => ({
      measuredAt: new Date().toISOString(), measurement: 'owned-file-logical-bytes',
      databases: { files: 0, bytes: 0 }, attachments: { files: 0, bytes: 0 },
      privateFiles: { files: 0, bytes: 0 }, derivedCaches: { files: 0, bytes: 0 },
      unpublishedAttachments: { files: 0, bytes: 0 }, totalBytes: 0
    }) },
    diagnostics: { view: { getSnapshot: () => diagnostics, subscribe: (listener: () => void) => {
      diagnosticListeners.add(listener); return () => { diagnosticListeners.delete(listener); };
    } } }
  } as unknown as ModuleServices;
  return <StrictMode><App services={scoped} registry={registry} /></StrictMode>;
}
