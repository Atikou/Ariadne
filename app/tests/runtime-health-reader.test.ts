import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeHealth, RuntimeResult, RuntimeStatus } from '@ariadne/protocol/public';
import type { AriadneApi, Result } from '../src/shared/contract';
import { RuntimeHealthReader } from '../src/renderer/src/core/runtime/runtime-health-reader';

const at = '2032-01-01T00:00:00.000Z';
const status = (availability: RuntimeStatus['availability']): RuntimeStatus => ({ availability, observedAt: at, capabilities: [] });
function result(domain: 'projection' | 'workflow' = 'projection'): Result<RuntimeResult> {
  const health: RuntimeHealth = { contractVersion: '1.0', observedAt: at, coverage: 'registered_domains',
    domains: [{ domain, source: domain, observedAt: at, revision: 2, availability: 'unavailable',
      code: 'authority_unavailable', recovery: 'repair' }] };
  return { ok: true, value: { kind: 'runtime.health', health } };
}
const readers: RuntimeHealthReader[] = [];
afterEach(() => { for (const reader of readers.splice(0)) reader.dispose(); vi.useRealTimers(); });
function reader(request: AriadneApi['runtime']['request']) { const value = new RuntimeHealthReader(request); readers.push(value); return value; }

describe('independent Runtime health reader', () => {
  it('reads the Main-retained startup diagnosis while Runtime is disabled', async () => {
    vi.useFakeTimers(); const request = vi.fn<AriadneApi['runtime']['request']>().mockResolvedValue(result());
    const value = reader(request); value.acceptStatus(status('disabled')); await value.refresh();
    expect(value.getSnapshot()).toMatchObject({ state: 'ready', health: { domains: [{ availability: 'unavailable' }] } });
    value.acceptStatus(status('starting')); expect(value.getSnapshot()).toMatchObject({ state: 'unknown', health: null });
    await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledTimes(1);
  });
  it('uses only the health read and retains honest unavailability instead of depending on Projection success', async () => {
    vi.useFakeTimers();
    const request = vi.fn<AriadneApi['runtime']['request']>().mockResolvedValue(result());
    const value = reader(request); value.acceptStatus(status('ready')); await value.refresh();
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'runtime.health.get' });
    expect(value.getSnapshot()).toMatchObject({ state: 'ready', health: { domains: [{ domain: 'projection', availability: 'unavailable' }] } });
    await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledTimes(2);
  });
  it('retains one physical reservation across Runtime replacement and ignores the earlier generation', async () => {
    vi.useFakeTimers(); let resolve!: (result: Result<RuntimeResult>) => void;
    const request = vi.fn<AriadneApi['runtime']['request']>()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(result('workflow'));
    const value = reader(request); value.acceptStatus(status('ready'));
    const pending = value.refresh(); await Promise.resolve();
    value.acceptStatus(status('crashed')); value.acceptStatus(status('ready'));
    expect(value.refresh()).toBe(pending); expect(request).toHaveBeenCalledTimes(1);
    resolve(result()); await pending;
    expect(value.getSnapshot().state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(value.getSnapshot().health?.domains.map(domain => domain.domain)).toEqual(['workflow']);
  });
  it('does not resurrect data or a poll timer after dispose while an earlier response finishes', async () => {
    vi.useFakeTimers(); let resolve!: (result: Result<RuntimeResult>) => void;
    const value = reader(() => new Promise(done => { resolve = done; }));
    value.acceptStatus(status('ready')); const pending = value.refresh(); await Promise.resolve();
    value.dispose(); resolve(result()); await pending;
    expect(value.getSnapshot()).toMatchObject({ state: 'unknown', health: null });
    expect(vi.getTimerCount()).toBe(0);
    value.acceptStatus(status('disabled')); await value.refresh();
    expect(vi.getTimerCount()).toBe(0); expect(value.getSnapshot().state).toBe('unknown');
  });
  it('rejects malformed or failed replies without exposing private response errors and can retry', async () => {
    vi.useFakeTimers();
    const request = vi.fn<AriadneApi['runtime']['request']>()
      .mockRejectedValueOnce(new Error('private credential'))
      .mockResolvedValueOnce({ ok: true, value: { kind: 'acknowledged' } }).mockResolvedValue(result());
    const value = reader(request); value.acceptStatus(status('ready')); await value.refresh();
    expect(value.getSnapshot()).toEqual({ state: 'error', health: null, errorCode: 'runtime_health_unavailable' });
    await value.refresh(); expect(value.getSnapshot().errorCode).toBe('invalid_health_response');
    await value.refresh(); expect(value.getSnapshot().state).toBe('ready');
    expect(JSON.stringify(value.getSnapshot())).not.toContain('private credential');
  });
});
