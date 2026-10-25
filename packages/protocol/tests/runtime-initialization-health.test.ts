import { describe, expect, it } from 'vitest';
import { ARIADNE_RUNTIME_PROTOCOL, ARIADNE_RUNTIME_PROTOCOL_VERSION, parseRuntimeToHostMessage } from '../src/host.js';
const observedAt = '2026-10-06T00:00:00.000Z';
const source = { domain: 'journal', source: 'journal', availability: 'unavailable', observedAt, revision: 1,
  code: 'authority_unavailable', recovery: 'repair' };
const message = { protocol: ARIADNE_RUNTIME_PROTOCOL, protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
  runtimeInstanceId: '00000000-0000-4000-8000-000000000001', type: 'initialization_failed', contractVersion: '1.0',
  phase: 'command_journal', health: { contractVersion: '1.0', observedAt, coverage: 'registered_domains', domains: [source] } };
describe('minimal initialization health V1', () => {
  it('carries only a proven unavailable source, or explicitly empty coverage for an unknown failure', () => {
    expect(parseRuntimeToHostMessage(message)).toEqual(message);
    expect(parseRuntimeToHostMessage({ ...message, phase: 'unknown', health: { ...message.health, domains: [] } })).toMatchObject({ health: { domains: [] } });
  });
  it('rejects invented health, source aliases, arbitrary phase text and private payload fields', () => {
    for (const item of [
      { ...message, phase: '/private/database/path' }, { ...message, contractVersion: '2.0' }, { ...message, cause: 'private exception' },
      { ...message, health: { ...message.health, domains: [{ ...source, availability: 'healthy', code: 'none', recovery: 'none' }] } },
      { ...message, health: { ...message.health, domains: [{ ...source, source: 'execution' }] } },
      { ...message, health: { ...message.health, domains: [{ ...source, body: 'private body' }] } }
    ]) expect(() => parseRuntimeToHostMessage(item)).toThrow();
  });
});
