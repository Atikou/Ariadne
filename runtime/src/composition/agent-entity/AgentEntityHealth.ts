import type { RuntimeCommand } from '@ariadne/protocol/public';
import { RuntimeDomainHealth, backgroundCommandHealthDependencies,
  RuntimeDomainUnavailableError, type RuntimeDomainHealthSnapshot, type RuntimeHealthDomain } from '../../ingress/RuntimeDomainHealth.js';
import type { RuntimeCommandEnvelope } from '../../ingress/RuntimeIngress.js';
import type { RuntimeApplicationCommandResult } from '../../ingress/RuntimeApplication.js';
import { completedPublicError } from '../AgentPublicCommandFailures.js';
import { compileAgentCommandHealthPolicy } from './AgentCommandHealthPolicy.js';
import type { AgentPublicCommandOwnerSnapshot } from './command-owners/AgentPublicCommandOwnerTable.js';
import type { RuntimeAuthorityHealthSource } from '../../ingress/RuntimeAuthorityHealthSource.js';

interface HealthProbe { assertHealthy(): void }
interface BackgroundWorker extends HealthProbe { start(): Promise<void>; stop(): Promise<void>; hasQuarantinedTasks?(): boolean }

/** Health composition follows the existing owners; it creates no task,
 * storage or execution authority. Startup isolates optional worker failure
 * after the critical execution/publication fixed point has been verified. */
export class AgentEntityHealth {
  private readonly health = new RuntimeDomainHealth();
  private readonly workers: readonly [RuntimeHealthDomain, BackgroundWorker | undefined][];
  private readonly dependencies: (command: RuntimeCommand) => readonly RuntimeHealthDomain[];

  public constructor(execution: HealthProbe, projection: HealthProbe,
    workers: { schedule?: BackgroundWorker; workflow?: BackgroundWorker; goal?: BackgroundWorker },
    sources: { execution: HealthProbe; conversation: HealthProbe; productivity?: HealthProbe; memory?: RuntimeAuthorityHealthSource },
    commandOwners: readonly AgentPublicCommandOwnerSnapshot[], private readonly inferenceAdmission?: (command: RuntimeCommand) => void) {
    this.dependencies = compileAgentCommandHealthPolicy(commandOwners);
    this.workers = [['schedule', workers.schedule], ['workflow', workers.workflow], ['goal', workers.goal]];
    this.health.register('execution', { probe: () => { sources.execution.assertHealthy(); execution.assertHealthy(); },
      failureCode: 'authority_unavailable', recovery: 'restart' });
    this.health.register('conversation', { probe: () => sources.conversation.assertHealthy(),
      failureCode: 'authority_unavailable', recovery: 'repair' });
    this.health.register('productivity', { probe: () => {
      if (sources.productivity === undefined) throw new Error('productivity_source_not_configured');
      sources.productivity.assertHealthy();
    }, failureCode: 'authority_unavailable', recovery: 'repair' });
    this.health.register('projection', { probe: () => projection.assertHealthy(),
      failureCode: 'authority_unavailable', recovery: 'repair' });
    this.health.register('memory', { probe: () => {
      if (sources.memory === undefined) throw new Error('memory_source_not_configured');
      sources.memory.assertHealthy();
    }, failureCode: 'authority_unavailable', recovery: 'repair', externalRecovery: 'reconcile', hasExternalFailure: () => sources.memory?.hasExternalFailure?.() ?? false });
    for (const [domain, worker] of this.workers) {
      this.health.register(domain, { probe: () => {
        if (worker === undefined) throw new Error('background_worker_not_configured');
        worker.assertHealthy();
      }, failureCode: 'worker_failed', recovery: 'reconcile', hasQuarantinedTasks: () => worker?.hasQuarantinedTasks?.() ?? false });
    }
  }

  public assertCoreHealthy(): void { this.health.assertAvailable(['execution', 'projection']); }
  public assertCommandHealthy(command: RuntimeCommand): void {
    this.inferenceAdmission?.(command);
    this.health.assertAvailable(this.dependencies(command));
    this.health.assertAvailable(backgroundCommandHealthDependencies(command));
  }
  public execute(envelope: RuntimeCommandEnvelope,
    execute: () => Promise<RuntimeApplicationCommandResult | null>): Promise<RuntimeApplicationCommandResult | null> {
    try { this.assertCommandHealthy(envelope.command); }
    catch (error) {
      if (!(error instanceof RuntimeDomainUnavailableError)) return Promise.reject(error);
      return Promise.resolve(completedPublicError(envelope, `runtime_${error.health.domain}_unavailable`,
        `Runtime ${error.health.domain} domain is unavailable; recovery requires ${error.health.recovery}.`, false));
    }
    // Only admission errors are converted. A mutation's unknown outcome keeps
    // its original owner/journal reconciliation semantics.
    return execute();
  }
  public read(): readonly RuntimeDomainHealthSnapshot[] { return this.health.read(); }
  public async startBackgroundWorkers(): Promise<void> {
    for (const [domain, worker] of this.workers) {
      if (worker === undefined) continue;
      try { await worker.start(); }
      catch { this.health.fail(domain, 'unavailable'); }
    }
  }
  public async stopBackgroundWorkers(): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    for (const domain of ['schedule', 'goal', 'workflow'] as const) {
      const worker = this.workers.find(([registered]) => registered === domain)?.[1];
      try { await worker?.stop(); } catch (error) { failures.push(error); }
    }
    return failures;
  }
}
