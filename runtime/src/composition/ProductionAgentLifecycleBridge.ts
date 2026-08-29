import type {
  AgentDispatchLifecycleObservation,
  AgentDispatchLifecycleObserver,
  AgentEngine,
  AgentTurnInput,
  PreparedAgentDecision
} from '@ariadne/agent-core';

import type { AgentLifecycleHooks } from '../control/ports/AgentLifecycleHooks.js';

/** Connects typed v3 dispatch boundaries to configured Hooks without payload access. */
export class ProductionAgentLifecycleBridge
implements AgentDispatchLifecycleObserver {
  public constructor(
    private readonly hooks: AgentLifecycleHooks,
    private readonly terminalObserver?: {
      closeOwner(runId: string): void | Promise<void>;
    }
  ) {}

  public observe(observation: AgentDispatchLifecycleObservation): void {
    this.hooks.observe(
      observation.event,
      observation.eventId,
      observation.occurredAt
    );
    if (observation.terminal) {
      this.hooks.observe(
        'run.terminal.post',
        observation.runId,
        observation.occurredAt
      );
      try {
        void Promise.resolve(this.terminalObserver?.closeOwner(observation.runId))
          .catch(() => undefined);
      } catch {
        // Resource cleanup is observer-only and cannot change committed Run state.
      }
    }
  }

  public observeRuntimeStop(occurredAt: string): void {
    this.hooks.observe('runtime.stop', 'runtime', occurredAt);
  }
}

/** Applies inference.dispatch.pre before Provider preparation or durable I/O. */
export class LifecycleHookedAgentEngine implements AgentEngine {
  public constructor(
    private readonly inner: AgentEngine,
    private readonly hooks: AgentLifecycleHooks
  ) {}

  public prepare(input: AgentTurnInput, signal: AbortSignal): Promise<PreparedAgentDecision> {
    const turn = input.run.turns.at(-1);
    const attempt = turn?.attempts.at(-1);
    if (turn === undefined || attempt === undefined) {
      return Promise.reject(new Error('agent_inference_hook_identity_unavailable'));
    }
    this.hooks.enforce(
      'inference.dispatch.pre',
      attempt.attemptId,
      new Date().toISOString()
    );
    return this.inner.prepare(input, signal);
  }
}
