export interface AgentDispatchLifecycleObservation {
  readonly event: 'inference.dispatch.post' | 'tool.dispatch.post' | 'turn.commit.post';
  readonly eventId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly outcome: string;
  readonly terminal: boolean;
}

/** Observer-only port invoked after durable dispatch commits. */
export interface AgentDispatchLifecycleObserver {
  observe(observation: AgentDispatchLifecycleObservation): void | Promise<void>;
}

export function observeAgentDispatchLifecycle(
  observer: AgentDispatchLifecycleObserver | undefined,
  observation: AgentDispatchLifecycleObservation
): void {
  if (observer === undefined) return;
  try {
    void Promise.resolve(observer.observe(Object.freeze({ ...observation })))
      .catch(() => undefined);
  } catch {
    // Observer failure must never change committed Agent state.
  }
}
