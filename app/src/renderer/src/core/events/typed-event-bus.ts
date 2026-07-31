export type EventHandler<TPayload> = (payload: TPayload) => void;
export type Unsubscribe = () => void;

export class TypedEventBus<TEvents extends { [K in keyof TEvents]: unknown }> {
  private readonly listeners = new Map<keyof TEvents, Set<EventHandler<unknown>>>();
  private readonly retained = new Map<keyof TEvents, unknown>();

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of [...handlers]) {
      handler(payload);
    }
  }

  emitRetained<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    this.retained.set(event, payload);
    this.emit(event, payload);
  }

  subscribe<TKey extends keyof TEvents>(event: TKey, handler: EventHandler<TEvents[TKey]>): Unsubscribe {
    const handlers = this.listeners.get(event) ?? new Set<EventHandler<unknown>>();
    handlers.add(handler as EventHandler<unknown>);
    this.listeners.set(event, handlers);
    if (this.retained.has(event)) {
      handler(this.retained.get(event) as TEvents[TKey]);
    }

    return () => {
      handlers.delete(handler as EventHandler<unknown>);
      if (handlers.size === 0) this.listeners.delete(event);
    };
  }
}
