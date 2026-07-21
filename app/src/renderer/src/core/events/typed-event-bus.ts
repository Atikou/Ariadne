export type EventHandler<TPayload> = (payload: TPayload) => void;
export type Unsubscribe = () => void;

export class TypedEventBus<TEvents extends { [K in keyof TEvents]: unknown }> {
  private readonly listeners = new Map<keyof TEvents, Set<EventHandler<unknown>>>();

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of [...handlers]) {
      handler(payload);
    }
  }

  subscribe<TKey extends keyof TEvents>(event: TKey, handler: EventHandler<TEvents[TKey]>): Unsubscribe {
    const handlers = this.listeners.get(event) ?? new Set<EventHandler<unknown>>();
    handlers.add(handler as EventHandler<unknown>);
    this.listeners.set(event, handlers);

    return () => {
      handlers.delete(handler as EventHandler<unknown>);
      if (handlers.size === 0) this.listeners.delete(event);
    };
  }
}
