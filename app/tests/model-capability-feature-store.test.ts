import { describe, expect, it, vi } from 'vitest';
import { runtimeCommandSchema, type RuntimeResult } from '@ariadne/protocol/public';
import { ModelFeatureStore } from '../src/renderer/src/core/runtime/features/model-feature-store';

const qualification: RuntimeResult = { kind: 'model.qualification.completed', modelId: 'model',
  supportsTextChat: true, supportsAgent: false, supportsPlan: false, supportsVision: false, qualificationState: 'qualified' };
const availability: RuntimeResult = { kind: 'model.availability.completed', modelId: 'model', available: true };
function fixture(result: RuntimeResult) {
  const execute = vi.fn(async (input: unknown) => { runtimeCommandSchema.parse(input); return result; });
  const synchronize = vi.fn(async () => {});
  const source = { getSnapshot: () => ({ models: [], modelsReadReady: true }), subscribe: () => () => {} };
  return { store: new ModelFeatureStore(source, { execute }, synchronize), execute, synchronize };
}

describe('model capability controls', () => {
  it('rechecks capabilities and refreshes the model cards', async () => {
    const f = fixture(qualification);
    await expect(f.store.qualify('model')).resolves.toEqual(qualification);
    expect(f.execute).toHaveBeenCalledWith({ kind: 'model.qualification.run', contractVersion: '5.0', modelId: 'model' });
    expect(f.synchronize).toHaveBeenCalledTimes(1);
  });
  it('checks provider availability without running a quality benchmark', async () => {
    const f = fixture(availability);
    await expect(f.store.checkAvailability('model')).resolves.toEqual(availability);
    expect(f.execute).toHaveBeenCalledWith({ kind: 'model.availability.check', contractVersion: '5.0', modelId: 'model' });
  });
  it('rejects capability results for another model or another command', async () => {
    for (const result of [{ ...qualification, modelId: 'other' }, availability]) {
      const f = fixture(result);
      await expect(f.store.qualify('model')).rejects.toThrow('result_invalid');
      expect(f.synchronize).not.toHaveBeenCalled();
    }
  });
  it('rejects availability results for another model or another command', async () => {
    for (const result of [{ ...availability, modelId: 'other' }, qualification]) {
      await expect(fixture(result).store.checkAvailability('model')).rejects.toThrow('result_invalid');
    }
  });
});
