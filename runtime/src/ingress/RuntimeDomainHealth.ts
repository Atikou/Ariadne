import { PUBLIC_RUNTIME_HEALTH_DOMAINS, type RuntimeCommand } from '@ariadne/protocol/public';
import type { RuntimeDomainHealthSnapshot, RuntimeHealthDomain, RuntimeHealthAvailability,
  RuntimeHealthRecovery, RuntimeHealthCode } from '@ariadne/protocol/public';
export type { RuntimeDomainHealthSnapshot, RuntimeHealthDomain, RuntimeHealthAvailability,
  RuntimeHealthRecovery, RuntimeHealthCode } from '@ariadne/protocol/public';
export const RUNTIME_HEALTH_DOMAINS = PUBLIC_RUNTIME_HEALTH_DOMAINS;
interface Registration {
  readonly probe: () => void;
  /** A derived signal from already-read durable fault metadata, not a reset. */
  readonly hasQuarantinedTasks?: () => boolean;
  readonly hasExternalFailure?: () => boolean;
  readonly externalRecovery?: Exclude<RuntimeHealthRecovery, 'none'>;
  readonly failureCode: Exclude<RuntimeHealthCode, 'none'>;
  readonly recovery: Exclude<RuntimeHealthRecovery, 'none'>;
  /** Reconcile existing durable identities; this must not resend unknown work. */
  readonly reconcile?: () => Promise<void>;
}
interface Entry { readonly registration: Registration; snapshot: RuntimeDomainHealthSnapshot; recovering: boolean; derivedCode: RuntimeHealthCode | null }

export class RuntimeDomainUnavailableError extends Error {
  public constructor(public readonly health: RuntimeDomainHealthSnapshot) {
    super(`runtime_domain_unavailable:${health.domain}`);
  }
}

/** Read/cancel/pause actions do not require a working background scanner.
 * Creation or resume of automatic work must not silently queue into a failed
 * worker. Core authority/projection admission is checked separately. */
export function backgroundCommandHealthDependencies(command: RuntimeCommand): readonly RuntimeHealthDomain[] {
  if (command.kind === 'schedule.create' || command.kind === 'schedule.occurrence.retry'
    || (command.kind === 'schedule.transition' && command.action === 'resume')) return ['schedule'];
  if (command.kind === 'workflow.start' && command.executionMode === 'agent') return ['workflow'];
  if (command.kind === 'goal.autonomy.start'
    || (command.kind === 'goal.autonomy.transition' && command.action === 'resume')) return ['goal', 'workflow'];
  return [];
}

/** Bounded composition health. It owns admission/diagnostic state only;
 * Run outcomes and durable command/task identities stay with their owners.
 * Failure stays latched until an explicit, revision-bound reconciliation. */
export class RuntimeDomainHealth {
  private readonly entries = new Map<RuntimeHealthDomain, Entry>();
  public constructor(private readonly now: () => Date = () => new Date()) {}

  public register(domain: RuntimeHealthDomain, registration: Registration): void {
    if (this.entries.has(domain)) throw new Error('runtime_health_domain_duplicate');
    this.entries.set(domain, { registration: Object.freeze({ ...registration }), recovering: false, derivedCode: null, snapshot: Object.freeze({
      domain, source: domain, availability: 'healthy', observedAt: this.timestamp(),
      revision: 1, code: 'none', recovery: 'none'
    }) });
  }

  public fail(domain: RuntimeHealthDomain, availability: Exclude<RuntimeHealthAvailability, 'healthy'>,
    code?: Exclude<RuntimeHealthCode, 'none'>): void {
    const entry = this.require(domain);
    entry.derivedCode = null;
    entry.snapshot = Object.freeze({ domain, source: domain, availability, observedAt: this.timestamp(),
      revision: this.nextRevision(entry), code: code ?? entry.registration.failureCode,
      recovery: entry.registration.recovery });
  }

  public read(): readonly RuntimeDomainHealthSnapshot[] {
    return Object.freeze(RUNTIME_HEALTH_DOMAINS.filter(domain => this.entries.has(domain)).map(domain => this.observe(domain)));
  }

  public assertAvailable(domains: readonly RuntimeHealthDomain[]): void {
    for (const domain of domains) {
      const snapshot = this.observe(domain);
      if (snapshot.availability === 'unavailable') throw new RuntimeDomainUnavailableError(snapshot);
    }
  }

  public async reconcile(domain: RuntimeHealthDomain, expectedRevision: number): Promise<RuntimeDomainHealthSnapshot> {
    const entry = this.require(domain);
    if (entry.snapshot.revision !== expectedRevision || entry.recovering) throw new Error('runtime_health_recovery_conflict');
    if (entry.snapshot.availability === 'healthy') return entry.snapshot;
    if (entry.registration.reconcile === undefined) throw new Error('runtime_health_recovery_unavailable');
    entry.recovering = true;
    try {
      await entry.registration.reconcile();
      // A newer fault wins even if the reconciliation just completed. Probe
      // before clearing the latch; no timer can make unavailable data healthy.
      if (entry.snapshot.revision !== expectedRevision) throw new Error('runtime_health_recovery_conflict');
      entry.registration.probe();
      if (entry.snapshot.revision !== expectedRevision) throw new Error('runtime_health_recovery_conflict');
      entry.snapshot = Object.freeze({ domain, source: domain, availability: 'healthy', observedAt: this.timestamp(),
        revision: this.nextRevision(entry), code: 'none', recovery: 'none' });
      return entry.snapshot;
    } finally { entry.recovering = false; }
  }

  private observe(domain: RuntimeHealthDomain): RuntimeDomainHealthSnapshot {
    const entry = this.require(domain);
    if (entry.snapshot.availability !== 'unavailable') {
      try {
        entry.registration.probe();
        const code = entry.registration.hasQuarantinedTasks?.() === true ? 'task_quarantined'
          : entry.registration.hasExternalFailure?.() === true ? 'external_unavailable' : null;
        if (code !== null && (entry.snapshot.availability === 'healthy' || (entry.derivedCode !== null && entry.derivedCode !== code))) {
          this.fail(domain, 'degraded', code); entry.derivedCode = code;
          if (code === 'external_unavailable' && entry.registration.externalRecovery !== undefined)
            entry.snapshot = Object.freeze({ ...entry.snapshot, recovery: entry.registration.externalRecovery });
        } else if (code === null && entry.derivedCode !== null) {
          entry.snapshot = Object.freeze({ domain, source: domain, availability: 'healthy', observedAt: this.timestamp(),
            revision: this.nextRevision(entry), code: 'none', recovery: 'none' });
          entry.derivedCode = null;
        }
      } catch { this.fail(domain, 'unavailable'); }
    }
    return entry.snapshot;
  }
  private require(domain: RuntimeHealthDomain): Entry {
    const entry = this.entries.get(domain);
    if (entry === undefined) throw new Error('runtime_health_domain_unregistered');
    return entry;
  }
  private timestamp(): string { return this.now().toISOString(); }
  private nextRevision(entry: Entry): number {
    const value = entry.snapshot.revision + 1;
    if (!Number.isSafeInteger(value)) throw new Error('runtime_health_revision_exhausted');
    return value;
  }
}
