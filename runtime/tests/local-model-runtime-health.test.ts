import { describe, expect, it } from 'vitest';
import { LocalModelRuntimeManager } from '../src/model/local/LocalModelRuntimeManager.js';
import { LocalRuntimeUnavailableError } from '../src/model/local/LocalRuntimeUnavailableError.js';
import { ModelTimeoutError } from '../src/model/modelCancellation.js';
import type { LocalModelDescriptor, LocalModelRuntime } from '../src/model/local/types.js';

const model: LocalModelDescriptor = { id: 'owned-local', displayName: 'Owned local', format: 'gguf', runtime: 'llama.cpp',
  modelPath: 'C:\\fixture\\model.gguf', sourcePath: 'C:\\fixture\\model.gguf', sizeBytes: 1,
  modifiedAt: '2026-10-06T00:00:00.000Z', status: 'ready' };
const ids = new Set([model.id]);
function fixture() {
  let failure: unknown = null, loadFailure: unknown = null, cleanupFailure: unknown = null;
  const runtime: LocalModelRuntime = { kind: 'llama.cpp', isAvailable: async () => true,
    load: async () => { if (loadFailure) throw loadFailure; },
    countTokens: async () => ({ tokens: 1, exact: true, method: 'model_tokenizer', tokenizer: 'fixture' }),
    generate: async () => { if (failure) throw failure; return { content: 'ready', toolCalls: [], clientName: model.id,
      modelName: model.id, location: 'local', latencyMs: 1 }; }, unload: async () => undefined,
    dispose: async () => { if (cleanupFailure) throw cleanupFailure; } };
  return { manager: new LocalModelRuntimeManager({ maxLoadedModels: 1, idleUnloadMs: 100_000, runtimeFactory: () => runtime }),
    setFailure: (next: unknown) => { failure = next; }, setLoadFailure: (next: unknown) => { loadFailure = next; },
    setCleanupFailure: (next: unknown) => { cleanupFailure = next; } };
}
describe('actual embedded runtime manager failure evidence', () => {
  it('clears only after a complete generate and ignores ping, token count and unrelated bindings', async () => {
    const owner = fixture(), { manager } = owner;
    try {
      const failure = new LocalRuntimeUnavailableError('local_model_load_failed', new Error('private model path'));
      owner.setLoadFailure(failure);
      await expect(manager.generate(model, { messages: [] })).rejects.toBe(failure);
      expect(manager.hasExternalFailure(ids)).toBe(true);
      expect(manager.hasExternalFailure(new Set(['other']))).toBe(false);
      owner.setLoadFailure(null);
      await manager.isAvailable('llama.cpp'); await manager.countTokens(model, { messages: [] });
      expect(manager.hasExternalFailure(ids)).toBe(true);
      await manager.generate(model, { messages: [] });
      expect(manager.hasExternalFailure(ids)).toBe(false);
    } finally { owner.setCleanupFailure(null); await manager.dispose(); }
  });
  it('does not label unknown callbacks or cancellation as model failure and retains newer queued failures', async () => {
    const owner = fixture(), { manager } = owner;
    try {
      owner.setFailure(new Error('arbitrary callback error'));
      await expect(manager.generate(model, { messages: [] })).rejects.toThrow('arbitrary callback error');
      expect(manager.hasExternalFailure(ids)).toBe(false);
      const abort = new AbortController(); abort.abort();
      await expect(manager.generate(model, { messages: [], signal: abort.signal })).rejects.toThrow();
      expect(manager.hasExternalFailure(ids)).toBe(false);
      owner.setFailure(new ModelTimeoutError('owned timeout'));
      await expect(manager.generate(model, { messages: [] })).rejects.toBeInstanceOf(ModelTimeoutError);
      expect(manager.hasExternalFailure(ids)).toBe(true);
      owner.setFailure(new Error('another callback error'));
      await expect(manager.generate(model, { messages: [] })).rejects.toThrow('another callback error');
      expect(manager.hasExternalFailure(ids)).toBe(true);
      manager.retainModelBindings(new Set()); expect(manager.hasExternalFailure(ids)).toBe(false);
    } finally { await manager.dispose(); }
  });
  it('keeps both a typed load failure and failed cleanup without erasing the model failure', async () => {
    const owner = fixture(), { manager } = owner;
    const load = new LocalRuntimeUnavailableError('local_model_load_failed', new Error('private')), cleanup = new Error('cleanup failed');
    owner.setLoadFailure(load); owner.setCleanupFailure(cleanup);
    try {
      const result = await manager.generate(model, { messages: [] }).catch(error => error);
      expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toEqual([load, cleanup]);
      expect(manager.hasExternalFailure(ids)).toBe(true);
    } finally { owner.setCleanupFailure(null); await manager.dispose(); }
  });
});
