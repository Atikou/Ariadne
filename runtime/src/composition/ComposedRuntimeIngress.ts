import { createHash } from 'node:crypto';

import {
  assertCanonicalAbsoluteDataRoot,
  type RuntimeBuildManifest,
  type RuntimeCancel,
  type RuntimeResponse
} from '@ariadne/protocol/host';
import type {
  AgentControlRuntimeFactory,
  AgentControlRuntimeLifecycle
} from '../ingress/AgentControlLifecycle.js';
import { boundedCanonicalJson } from '../ingress/BoundedCanonicalJson.js';
import type {
  RuntimeApplication,
  RuntimeApplicationFactory
} from '../ingress/RuntimeApplication.js';
import type {
  RuntimeCommandJournal,
  RuntimeCommandOutcome,
  RuntimeCommandReconciliation
} from '../ingress/RuntimeCommandJournal.js';
import {
  RuntimeIngressInitializationError,
  type RuntimeCommandEnvelope,
  type RuntimeIngress,
  type RuntimeIngressCommandStatus,
  type RuntimeIngressInitialization,
  type RuntimeIngressReady
} from '../ingress/RuntimeIngress.js';
import {
  createShutdownContext,
  type ShutdownContext
} from '../ingress/ShutdownContext.js';
import { RuntimeLifecycleRegistry } from './RuntimeLifecycleRegistry.js';
import { DeferredProjectionWakeEventSink } from './DeferredProjectionWakeEventSink.js';
import type { AgentProcessSandboxFactory } from '../control/ports/AgentProcessSandbox.js';

export const ARIADNE_RUNTIME_VERSION = '0.1.0';

interface ActiveCommand {
  readonly digest: string;
  readonly correlationId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  forcedOutcome?: RuntimeCommandOutcome;
  interruptFailure?: unknown;
}

export interface ComposedRuntimeIngressDependencies {
  readonly commandJournal: RuntimeCommandJournal;
  readonly agentControlFactory?: AgentControlRuntimeFactory;
  readonly preflightMemoryControlShadows: (dataRoot: string) => unknown;
  readonly runtimeApplicationFactory: RuntimeApplicationFactory;
  readonly readBuildManifest?: () => RuntimeBuildManifest;
  readonly validateBuildIdentity?: boolean;
  readonly runtimeVersion?: string;
  readonly processSandboxFactory?: AgentProcessSandboxFactory;
}

/**
 * Composition-owned implementation of the Runtime ingress port.
 *
 * It is the sole owner of bootstrap preflight, control-store acquisition,
 * injected RuntimeApplication construction, command-journal admission and
 * ordered shutdown.
 */
export class ComposedRuntimeIngress implements RuntimeIngress {
  private lifecycle: 'new' | 'initializing' | 'ready' | 'closing' | 'closed' | 'failed' = 'new';
  private application?: RuntimeApplication;
  private agentControl?: AgentControlRuntimeLifecycle;
  private projectionWakeEventSink?: DeferredProjectionWakeEventSink;
  private readonly activeCommands = new Map<string, ActiveCommand>();
  private readonly inFlightExecutions = new Set<Promise<RuntimeCommandOutcome>>();
  private shutdownOperation?: Promise<void>;

  public constructor(
    private readonly dependencies: ComposedRuntimeIngressDependencies
  ) {}

  public async initialize(
    input: RuntimeIngressInitialization
  ): Promise<RuntimeIngressReady> {
    if (this.lifecycle !== 'new') {
      throw new RuntimeIngressInitializationError(
        'bootstrap',
        'RUNTIME_INGRESS_ALREADY_INITIALIZED',
        'Runtime ingress was already initialized.'
      );
    }
    this.lifecycle = 'initializing';
    const registry = new RuntimeLifecycleRegistry();
    let phase = 'bootstrap';
    try {
      const { bootstrap } = input;
      assertCanonicalAbsoluteDataRoot(bootstrap.dataRoot);
      const runtimeVersion = this.dependencies.runtimeVersion ?? ARIADNE_RUNTIME_VERSION;
      const validateBuildIdentity = this.dependencies.validateBuildIdentity ?? true;
      const buildManifest = validateBuildIdentity
        ? this.requireBuildManifest()
        : {
            schemaVersion: 1 as const,
            runtimeVersion,
            fingerprint: bootstrap.runtimeBuildFingerprint
          };
      if (
        buildManifest.runtimeVersion !== runtimeVersion
        || buildManifest.runtimeVersion !== bootstrap.runtimeVersion
        || (
          validateBuildIdentity
          && buildManifest.fingerprint !== bootstrap.runtimeBuildFingerprint
        )
      ) {
        throw new Error('runtime_build_identity_mismatch');
      }

      phase = 'legacy_control_preflight';
      this.dependencies.preflightMemoryControlShadows(bootstrap.dataRoot);

      phase = 'command_journal';
      this.dependencies.commandJournal.open(bootstrap.dataRoot);
      registry.register({
        name: 'command_journal',
        close: () => this.dependencies.commandJournal.close()
      });

      phase = 'runtime_application';
      this.application = await this.dependencies.runtimeApplicationFactory.create({
        bootstrap,
        hostCapabilities: input.hostCapabilities,
        emitEvent: input.emitEvent,
        runtimeVersion
      });
      const application = this.application;
      registry.register({
        name: 'runtime_application',
        close: (context) => application.disposeInitialization(context)
      });

      if (this.dependencies.agentControlFactory) {
        phase = 'agent_control';
        if (!input.hostCapabilities) {
          throw new Error('runtime_host_capability_client_required');
        }
        const projectionWakeEventSink = new DeferredProjectionWakeEventSink();
        this.projectionWakeEventSink = projectionWakeEventSink;
        projectionWakeEventSink.bind(application.publicEventSink);
        registry.register({
          name: 'projection_wake_event_sink',
          close: (context) => projectionWakeEventSink.close(context)
        });
        this.agentControl = await this.dependencies.agentControlFactory.create({
          dataRoot: bootstrap.dataRoot,
          installRoot: bootstrap.installRoot,
          production: bootstrap.production,
          runtimeInstanceId: bootstrap.runtimeInstanceId,
          agentAdmissionAuthoritySource: bootstrap.agentAdmissionAuthoritySource,
          modelProviders: bootstrap.modelProviders,
          workspaces: bootstrap.workspaces,
          runtimePolicy: bootstrap.runtimePolicy,
          agentPermissions: bootstrap.agentPermissions,
          processSandboxFactory: this.dependencies.processSandboxFactory,
          credentialEnvironment: process.env,
          modelCatalog: application.modelCatalog,
          ...(application.modelInferenceGateway === undefined
            ? {}
            : { modelInferenceGateway: application.modelInferenceGateway }),
          publicEventSink: projectionWakeEventSink,
          hostCapabilities: input.hostCapabilities
        });
        const agentControl = this.agentControl;
        registry.register({
          name: 'agent_control',
          close: (context) => agentControl.shutdown(context)
        });
      }

      phase = 'agent_control_start';
      await this.agentControl?.start();
      this.agentControl?.assertHealthy();
      phase = 'runtime_application_start';
      await application.start();
      phase = 'projection_wake_enable';
      this.projectionWakeEventSink?.enable();
      phase = 'ready';
      this.lifecycle = 'ready';
      registry.commit();
      return {
        runtimeVersion,
        runtimeBuildFingerprint: buildManifest.fingerprint,
        status: application.status(),
        storageSchemas: {
          ...application.storageSchemas,
          runtimeCommand: this.dependencies.commandJournal.schemaVersion,
          ...(this.agentControl?.storageSchemas ?? {})
        }
      };
    } catch (error) {
      const cleanupContext = createShutdownContext(Date.now() + 5_000);
      let cleanupFailures: readonly unknown[] = [];
      try {
        cleanupFailures = await registry.rollback(cleanupContext);
      } finally {
        cleanupContext.dispose();
      }
      this.application = undefined;
      this.agentControl = undefined;
      this.projectionWakeEventSink = undefined;
      this.lifecycle = 'failed';
      const cause = cleanupFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupFailures],
            'runtime_initialization_and_cleanup_failed'
          );
      throw new RuntimeIngressInitializationError(
        phase,
        initializationErrorCode(error),
        'Runtime initialization failed.',
        { cause }
      );
    }
  }

  public execute(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandOutcome> {
    let tracked!: Promise<RuntimeCommandOutcome>;
    tracked = this.executeCommand(envelope).finally(() => {
      this.inFlightExecutions.delete(tracked);
    });
    this.inFlightExecutions.add(tracked);
    return tracked;
  }

  private async executeCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandOutcome> {
    if (this.lifecycle !== 'ready' || !this.application) {
      return errorOutcome(
        envelope.correlationId,
        this.lifecycle === 'closing' || this.lifecycle === 'closed'
          ? 'runtime_shutting_down'
          : 'runtime_not_ready',
        this.lifecycle === 'closing' || this.lifecycle === 'closed'
          ? 'Runtime is shutting down.'
          : 'Runtime is not ready.',
        false
      );
    }
    try {
      this.agentControl?.assertHealthy();
    } catch {
      return errorOutcome(
        envelope.correlationId,
        'runtime_unhealthy',
        'Runtime is unavailable because its public Agent projection is unhealthy.',
        false
      );
    }

    const digest = digestCommand(envelope.command);
    const active = this.activeCommands.get(envelope.commandId);
    if (active) {
      return active.digest === digest
        ? uncertainOutcome(envelope.correlationId, 'caller_cancelled', true)
        : errorOutcome(
            envelope.correlationId,
            'command_id_conflict',
            'The commandId is already bound to a different command.',
            false
          );
    }

    let admission = this.dependencies.commandJournal.begin(
      envelope.commandId,
      digest
    );
    if (admission.kind === 'conflict') {
      return errorOutcome(
        envelope.correlationId,
        'command_id_conflict',
        'The commandId is already bound to a different command.',
        false
      );
    }
    if (admission.kind === 'replay') return admission.outcome;
    if (admission.kind === 'uncertain') {
      let reconciliation: RuntimeCommandReconciliation | null;
      try {
        reconciliation = await this.agentControl?.reconcileUncertainCommand(
          envelope
        ) ?? null;
      } catch {
        return uncertainOutcome(envelope.correlationId, 'caller_cancelled', true);
      }
      if (reconciliation === null) {
        return uncertainOutcome(envelope.correlationId, 'caller_cancelled', true);
      }
      admission = this.dependencies.commandJournal.reconcileUncertain(
        envelope.commandId,
        digest,
        reconciliation
      );
      if (admission.kind === 'conflict') {
        return errorOutcome(
          envelope.correlationId,
          'command_id_conflict',
          'The commandId is already bound to a different command.',
          false
        );
      }
      if (admission.kind === 'replay') return admission.outcome;
      if (admission.kind === 'uncertain') {
        return uncertainOutcome(envelope.correlationId, 'caller_cancelled', true);
      }
    }

    // Reconciliation is an accepted Ingress attempt even before a side-effect
    // command record exists. If shutdown began while awaiting its durable
    // owner, settle a proven-not-executed command without entering Runtime.
    if (this.lifecycle !== 'ready') {
      const outcome = errorOutcome(
        envelope.correlationId,
        'runtime_shutting_down',
        'Runtime shutdown began before the command entered execution.',
        false
      );
      this.dependencies.commandJournal.complete(envelope.commandId, digest, outcome);
      return outcome;
    }

    const deadline = Date.parse(envelope.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      const outcome = errorOutcome(
        envelope.correlationId,
        'deadline_exceeded',
        'The logical command exceeded its deadline before entering Runtime.',
        false
      );
      this.dependencies.commandJournal.complete(envelope.commandId, digest, outcome);
      return outcome;
    }

    const operationController = new AbortController();
    let settleActiveCommand!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleActiveCommand = resolve;
    });
    const record: ActiveCommand = {
      digest,
      correlationId: envelope.correlationId,
      controller: operationController,
      settled,
      settle: settleActiveCommand
    };
    this.activeCommands.set(envelope.commandId, record);
    const interrupt = (reason: RuntimeCancel['reason']): void => {
      try {
        this.interrupt(envelope.commandId, reason);
      } catch (error) {
        record.interruptFailure = error;
        operationController.abort(error);
      }
    };
    const onCallerAbort = (): void => interrupt(
      cancellationReason(envelope.signal.reason)
    );
    if (envelope.signal.aborted) onCallerAbort();
    else envelope.signal.addEventListener('abort', onCallerAbort, { once: true });
    const deadlineTimer = setTimeout(
      () => interrupt('deadline_exceeded'),
      Math.min(2_147_483_647, Math.max(0, deadline - Date.now()))
    );
    deadlineTimer.unref?.();

    try {
      let outcome: RuntimeCommandOutcome;
      let settlement: 'completed' | 'uncertain' = 'completed';
      let alreadyPersisted = false;
      try {
        operationController.signal.throwIfAborted();
        const routedEnvelope = {
          ...envelope,
          signal: operationController.signal
        };
        let result;
        if (this.agentControl) {
          const owned = await this.agentControl.executeOwnedCommand(routedEnvelope);
          operationController.signal.throwIfAborted();
          result = owned ?? await this.application.execute(routedEnvelope);
        } else {
          result = await this.application.execute(routedEnvelope);
        }
        operationController.signal.throwIfAborted();
        if (record.forcedOutcome) {
          outcome = record.forcedOutcome;
          settlement = 'uncertain';
          alreadyPersisted = true;
        } else {
          outcome = result.outcome;
          settlement = result.settlement;
        }
      } catch (error) {
        if (record.interruptFailure !== undefined) throw record.interruptFailure;
        if (operationController.signal.aborted) {
          settlement = 'uncertain';
          const reason = cancellationReason(operationController.signal.reason);
          if (record.forcedOutcome) {
            outcome = record.forcedOutcome;
            alreadyPersisted = true;
          } else {
            outcome = uncertainOutcome(envelope.correlationId, reason);
          }
        } else {
          settlement = 'uncertain';
          outcome = errorOutcome(
            envelope.correlationId,
            'command_outcome_uncertain',
            'The Runtime command failed after execution began, so external side effects may be incomplete.',
            false
          );
        }
      }

      if (!alreadyPersisted) {
        if (settlement === 'completed') {
          this.dependencies.commandJournal.complete(
            envelope.commandId,
            digest,
            outcome
          );
        } else {
          this.dependencies.commandJournal.markUncertain(
            envelope.commandId,
            digest,
            outcome
          );
        }
      }
      return outcome;
    } finally {
      clearTimeout(deadlineTimer);
      envelope.signal.removeEventListener('abort', onCallerAbort);
      if (this.activeCommands.get(envelope.commandId) === record) {
        this.activeCommands.delete(envelope.commandId);
      }
      record.settle();
    }
  }

  public getCommandStatus(commandId: string): RuntimeIngressCommandStatus | null {
    return this.dependencies.commandJournal.getStatus(commandId);
  }

  public interrupt(
    commandId: string,
    reason: RuntimeCancel['reason']
  ): RuntimeCommandOutcome | null {
    const active = this.activeCommands.get(commandId);
    if (!active) return null;
    if (active.forcedOutcome) return active.forcedOutcome;
    const outcome = uncertainOutcome(active.correlationId, reason);
    this.dependencies.commandJournal.markUncertain(
      commandId,
      active.digest,
      outcome
    );
    active.forcedOutcome = outcome;
    active.controller.abort(new Error(reason));
    return outcome;
  }

  public shutdown(context: ShutdownContext): Promise<void> {
    if (
      this.lifecycle === 'new'
      || this.lifecycle === 'failed'
      || this.lifecycle === 'closed'
    ) {
      return Promise.resolve();
    }
    if (this.shutdownOperation) return this.shutdownOperation;
    this.lifecycle = 'closing';
    this.shutdownOperation = this.performShutdown(context);
    return this.shutdownOperation;
  }

  private async performShutdown(context: ShutdownContext): Promise<void> {
    const barrierFailures: unknown[] = [];
    await attemptShutdownStep(
      barrierFailures,
      () => this.stopAndDrainActiveCommands(context)
    );
    // RuntimeApplication preparation stops inference, effects and background
    // producers. Its public event pump is then flushed/stopped before the new
    // Control Plane performs the final fixed-point drain and freezes its UoWs.
    await attemptShutdownStep(
      barrierFailures,
      async () => this.application?.prepareShutdown(context)
    );
    await attemptShutdownStep(
      barrierFailures,
      async () => this.projectionWakeEventSink?.close(context)
    );
    await attemptShutdownStep(
      barrierFailures,
      async () => this.application?.stop(context)
    );
    await attemptShutdownStep(
      barrierFailures,
      async () => this.agentControl?.prepareShutdown(context)
    );
    if (barrierFailures.length > 0) {
      this.lifecycle = 'failed';
      // No business store or owner fence may be released unless every active
      // attempt, producer and fixed-point drain boundary is proven settled.
      throw new AggregateError(
        barrierFailures,
        'runtime_shutdown_barrier_failed'
      );
    }
    try {
      await this.closeStores(context);
    } catch (error) {
      this.lifecycle = 'failed';
      throw new AggregateError([error], 'runtime_shutdown_failed');
    }
    this.lifecycle = 'closed';
  }

  private async closeStores(context: ShutdownContext): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.agentControl?.shutdown(context);
      this.agentControl = undefined;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.application?.shutdown(context);
      this.application = undefined;
      this.projectionWakeEventSink = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      // The command journal is the final process-owner boundary. Retain it if
      // any business store close is uncertain so a replacement Runtime cannot
      // acquire a partial ownership set.
      throw new AggregateError(failures, 'runtime_business_store_shutdown_failed');
    }
    this.dependencies.commandJournal.close();
  }

  private async stopAndDrainActiveCommands(context: ShutdownContext): Promise<void> {
    const active = [...this.activeCommands.entries()];
    const executions = [...this.inFlightExecutions];
    const failures: unknown[] = [];
    for (const [commandId, record] of active) {
      try {
        this.interrupt(commandId, 'runtime_shutdown');
      } catch (error) {
        record.interruptFailure = error;
        record.controller.abort(error);
        failures.push(error);
      }
    }
    const settledExecutions = Promise.all(executions.map(async (execution) => {
      try {
        await execution;
      } catch (error) {
        failures.push(error);
      }
    })).then(() => undefined);
    await waitWithinShutdown(
      settledExecutions,
      context,
      'runtime_active_command_shutdown_deadline_exceeded'
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'runtime_active_command_interrupt_failed');
    }
  }

  private requireBuildManifest(): RuntimeBuildManifest {
    if (!this.dependencies.readBuildManifest) {
      throw new Error('runtime_build_manifest_reader_required');
    }
    return this.dependencies.readBuildManifest();
  }
}

async function waitWithinShutdown(
  operation: Promise<void>,
  context: ShutdownContext,
  errorCode: string
): Promise<void> {
  context.throwIfExpired(errorCode);
  const remaining = context.remainingMs();
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error(errorCode));
    timeout = setTimeout(fail, remaining);
    timeout.unref?.();
    onAbort = fail;
    context.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
  }
}

async function attemptShutdownStep(
  failures: unknown[],
  operation: () => void | Promise<void | undefined>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function initializationErrorCode(error: unknown): string {
  const structuredCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (/^[A-Z][A-Z0-9_]{2,63}$/u.test(structuredCode)) return structuredCode;
  const message = error instanceof Error ? error.message : '';
  const token = message.split(':', 1)[0] ?? '';
  return /^[a-z][a-z0-9_]{1,63}$/u.test(token)
    ? token.toUpperCase()
    : 'RUNTIME_INITIALIZATION_FAILED';
}

function digestCommand(command: RuntimeCommandEnvelope['command']): string {
  return createHash('sha256')
    .update(boundedCanonicalJson(command), 'utf8')
    .digest('hex');
}

function cancellationReason(reason: unknown): RuntimeCancel['reason'] {
  const value = reason instanceof Error ? reason.message : String(reason ?? '');
  if (value === 'deadline_exceeded') return 'deadline_exceeded';
  if (value === 'runtime_shutdown') return 'runtime_shutdown';
  return 'caller_cancelled';
}

function uncertainOutcome(
  correlationId: string,
  reason: RuntimeCancel['reason'],
  alreadyExecuting = false
): Extract<RuntimeCommandOutcome, { ok: false }> {
  const message = alreadyExecuting
    ? 'The logical command was already executing or its prior outcome is uncertain; automatic retry is forbidden.'
    : reason === 'deadline_exceeded'
      ? 'The logical command exceeded its deadline during execution; external side effects are uncertain and automatic retry is forbidden.'
      : reason === 'runtime_shutdown'
        ? 'The logical command was still executing during Runtime shutdown; external side effects are uncertain and automatic retry is forbidden.'
        : 'The logical command was cancelled during execution; external side effects are uncertain and automatic retry is forbidden.';
  return errorOutcome(
    correlationId,
    'command_outcome_uncertain',
    message,
    false
  );
}

function errorOutcome(
  correlationId: string,
  code: string,
  message: string,
  retryable: boolean
): Extract<RuntimeResponse['outcome'], { ok: false }> {
  const normalizedCode = /^[a-z][a-z0-9_]{1,127}$/u.test(code)
    ? code
    : 'runtime_request_failed';
  return {
    ok: false,
    error: {
      code: normalizedCode,
      message: message.slice(0, 4_096),
      retryable,
      correlationId
    }
  };
}
