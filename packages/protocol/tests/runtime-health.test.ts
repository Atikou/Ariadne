import { describe, expect, it } from 'vitest';
import { runtimeCommandSchema, runtimeResultSchema, runtimeHealthSchema } from '../src/public.js';

const at = '2032-01-01T00:00:00.000Z';
const domain = { domain: 'workflow', source: 'workflow', availability: 'unavailable', observedAt: at,
  revision: 2, code: 'worker_failed', recovery: 'reconcile' };
const health = { contractVersion: '1.0', observedAt: at, coverage: 'registered_domains', domains: [domain] };

describe('independent bounded Runtime health contract', () => {
  it('accepts explicit registered coverage and the side-effect-free read command', () => {
    expect(runtimeCommandSchema.parse({ kind: 'runtime.health.get' })).toEqual({ kind: 'runtime.health.get' });
    expect(runtimeResultSchema.parse({ kind: 'runtime.health', health })).toMatchObject({ health });
    expect(runtimeHealthSchema.parse({ ...health, domains: [] }).coverage).toBe('registered_domains');
  });
  it('rejects exception payloads, duplicate domains, excessive rows and false healthy metadata', () => {
    expect(() => runtimeCommandSchema.parse({ kind: 'runtime.health.get', path: 'private.db' })).toThrow();
    expect(() => runtimeHealthSchema.parse({ ...health, domains: [{ ...domain, exception: 'private payload' }] })).toThrow();
    expect(() => runtimeHealthSchema.parse({ ...health, domains: [domain, domain] })).toThrow();
    expect(() => runtimeHealthSchema.parse({ ...health, domains: Array(12).fill(domain) })).toThrow();
    for (const fields of [{ availability: 'healthy' }, { code: 'none' }, { recovery: 'none' }]) {
      expect(() => runtimeHealthSchema.parse({ ...health, domains: [{ ...domain, ...fields }] })).toThrow();
    }
  });
});
