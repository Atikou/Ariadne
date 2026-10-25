import type { ModelSummary, RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';
import { ModelFeatureStore } from '../src/renderer/src/core/runtime/features/model-feature-store';

const local: ModelSummary = {
  id: 'fixture-model', label: '【UI 夹具】Qwen3.5 9B Uncensored Aggressive Q4_K_M',
  location: 'local', availability: 'ready', enabled: true, supportsTextChat: true,
  supportsAgent: false, supportsPlan: false, supportsVision: false, qualificationState: 'qualified'
};
let snapshot = { models: [local, { ...local, id: 'fixture-offline', label: '【UI 夹具】离线模型', availability: 'unavailable' },
  { ...local, id: 'fixture-remote', label: '【UI 夹具】远程模型', location: 'remote' }] as ModelSummary[], modelsReadReady: true };
const listeners = new Set<() => void>();
const pending: Array<{ resolve(result: RuntimeResult): void; reject(error: Error): void }> = [];
const commands: RuntimeCommand[] = [];
let completed: Extract<RuntimeResult, { kind: 'model.qualification.completed' }> | undefined;

export const settingsModelControls = {
  commands,
  resolve: () => {
    completed = { kind: 'model.qualification.completed', modelId: local.id, supportsTextChat: true,
      supportsAgent: true, supportsPlan: true, supportsVision: false, qualificationState: 'qualified' };
    pending.shift()!.resolve(completed);
  },
  reject: () => pending.shift()!.reject(new Error('FIXTURE_CAPABILITY_CHECK_FAILED'))
};
export const settingsModels = new ModelFeatureStore({
  getSnapshot: () => snapshot,
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
}, {
  execute: command => {
    commands.push(command);
    if (command.kind !== 'model.qualification.run') throw new Error('Unexpected settings model command');
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  }
}, async () => {
  if (!completed) return;
  const { kind: _kind, modelId, ...capabilities } = completed;
  snapshot = { ...snapshot, models: snapshot.models.map(model => model.id === modelId ? { ...model, ...capabilities } : model) };
  listeners.forEach(listener => listener());
});
