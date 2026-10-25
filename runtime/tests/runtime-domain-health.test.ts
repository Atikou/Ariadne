import { describe, expect, it } from 'vitest';
import { RuntimeDomainHealth, RuntimeDomainUnavailableError } from '../src/ingress/RuntimeDomainHealth.js';

describe('bounded domain health and controlled recovery', () => {
  it('reports actual external degradation and never erases a later authority failure', () => {
    let external = true, damaged = false;
    const health = new RuntimeDomainHealth();
    health.register('memory', { probe() { if (damaged) throw new Error('actual source damage'); },
      hasExternalFailure: () => external, failureCode: 'authority_unavailable', recovery: 'repair', externalRecovery: 'reconcile' });
    expect(health.read()[0]).toMatchObject({ availability: 'degraded', code: 'external_unavailable', recovery: 'reconcile', revision: 2 });
    expect(health.read()[0]!.revision).toBe(2); external = false;
    expect(health.read()[0]).toMatchObject({ availability: 'healthy', revision: 3 });
    external = true; expect(health.read()[0]!.revision).toBe(4); damaged = true;
    expect(health.read()[0]).toMatchObject({ availability: 'unavailable', code: 'authority_unavailable', revision: 5 });
    external = false; damaged = false;
    expect(health.read()[0]).toMatchObject({ availability: 'unavailable', revision: 5 });
  });
  it('derives task degradation from durable task metadata without clearing a newer worker-wide failure', () => {
    let quarantined = true, broken = false;
    const health = new RuntimeDomainHealth();
    health.register('workflow', { probe() { if (broken) throw new Error('source failed'); },
      hasQuarantinedTasks: () => quarantined, failureCode: 'worker_failed', recovery: 'reconcile' });
    expect(health.read()[0]).toMatchObject({ availability: 'degraded', code: 'task_quarantined', revision: 2 });
    expect(() => health.assertAvailable(['workflow'])).not.toThrow();
    expect(health.read()[0]!.revision).toBe(2);
    quarantined = false;
    expect(health.read()[0]).toMatchObject({ availability: 'healthy', code: 'none', revision: 3 });
    quarantined = true;
    expect(health.read()[0]).toMatchObject({ availability: 'degraded', revision: 4 });
    broken = true;
    expect(health.read()[0]).toMatchObject({ availability: 'unavailable', code: 'worker_failed', revision: 5 });
    broken = false; quarantined = false;
    expect(health.read()[0]).toMatchObject({ availability: 'unavailable', revision: 5 });
  });
  it('isolates worker failure and exposes fixed safe metadata while admission checks only its dependencies', () => {
    let observed = new Date('2032-01-01T00:00:00.000Z');
    const health = new RuntimeDomainHealth(() => observed);
    health.register('conversation', { probe() {}, failureCode: 'authority_unavailable', recovery: 'repair' });
    health.register('workflow', { probe() { throw new Error('private input and credential'); }, failureCode: 'worker_failed', recovery: 'reconcile' });
    expect(() => health.assertAvailable(['conversation'])).not.toThrow();
    expect(() => health.assertAvailable(['workflow'])).toThrow(RuntimeDomainUnavailableError);
    const first = health.read(); observed = new Date('2032-01-02T00:00:00.000Z');
    expect(health.read()).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('private');
    expect(first).toHaveLength(2);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(first[1]).toMatchObject({ domain: 'workflow', source: 'workflow', code: 'worker_failed', recovery: 'reconcile', revision: 2 });
  });

  it('keeps authority failure latched and only clears it after exact-revision durable reconciliation and a healthy probe', async () => {
    const health = new RuntimeDomainHealth(); let unavailable = true, reconciled = 0;
    health.register('conversation', { probe() { if (unavailable) throw new Error('corrupt'); },
      failureCode: 'authority_unavailable', recovery: 'reconcile', reconcile: async () => { reconciled++; } });
    expect(() => health.assertAvailable(['conversation'])).toThrow();
    await expect(health.reconcile('conversation', 2)).rejects.toThrow('corrupt');
    expect(health.read()[0]!.availability).toBe('unavailable');
    unavailable = false;
    expect(() => health.assertAvailable(['conversation'])).toThrow();
    await expect(health.reconcile('conversation', 1)).rejects.toThrow('runtime_health_recovery_conflict');
    expect(reconciled).toBe(1);
    await expect(health.reconcile('conversation', 2)).resolves.toMatchObject({ revision: 3, availability: 'healthy' });
    expect(reconciled).toBe(2);
    expect(() => health.assertAvailable(['conversation'])).not.toThrow();
  });

  it('retains a newer fault and refuses concurrent recovery while reconciling existing work', async () => {
    const health = new RuntimeDomainHealth(); let done!: () => void;
    const barrier = new Promise<void>(resolve => { done = resolve; });
    health.register('schedule', { probe() {}, failureCode: 'worker_failed', recovery: 'reconcile', reconcile: () => barrier });
    health.fail('schedule', 'unavailable');
    const recovery = health.reconcile('schedule', 2);
    await expect(health.reconcile('schedule', 2)).rejects.toThrow('runtime_health_recovery_conflict');
    health.fail('schedule', 'unavailable', 'authority_unavailable'); done();
    await expect(recovery).rejects.toThrow('runtime_health_recovery_conflict');
    expect(health.read()[0]).toMatchObject({ revision: 3, availability: 'unavailable', code: 'authority_unavailable' });
  });

  it('allows degraded availability, rejects unregistered dependencies and requires an actual recovery owner', async () => {
    const health = new RuntimeDomainHealth();
    health.register('projection', { probe() {}, failureCode: 'authority_unavailable', recovery: 'repair' });
    health.fail('projection', 'degraded', 'task_quarantined');
    expect(() => health.assertAvailable(['projection'])).not.toThrow();
    expect(() => health.assertAvailable(['journal'])).toThrow('runtime_health_domain_unregistered');
    await expect(health.reconcile('projection', 2)).rejects.toThrow('runtime_health_recovery_unavailable');
    expect(() => health.register('projection', { probe() {}, failureCode: 'authority_unavailable', recovery: 'repair' })).toThrow('duplicate');
  });

  it('does not erase a fresh authority fault reported by the recovery probe', async () => {
    const health = new RuntimeDomainHealth();
    health.register('projection', { probe: () => health.fail('projection', 'unavailable'),
      failureCode: 'authority_unavailable', recovery: 'reconcile', reconcile: async () => {} });
    health.fail('projection', 'unavailable');
    await expect(health.reconcile('projection', 2)).rejects.toThrow('runtime_health_recovery_conflict');
    expect(health.read()[0]).toMatchObject({ revision: 3, availability: 'unavailable' });
  });

  it('still observes a worker-wide failure while one task is quarantined', () => {
    const health = new RuntimeDomainHealth(); let failed = false;
    health.register('workflow', { probe: () => { if (failed) throw new Error('worker_failed'); },
      failureCode: 'worker_failed', recovery: 'reconcile' });
    health.fail('workflow', 'degraded', 'task_quarantined');
    expect(() => health.assertAvailable(['workflow'])).not.toThrow();
    failed = true;
    expect(() => health.assertAvailable(['workflow'])).toThrow(RuntimeDomainUnavailableError);
    expect(health.read()[0]).toMatchObject({ availability: 'unavailable', code: 'worker_failed', revision: 3 });
  });
});
