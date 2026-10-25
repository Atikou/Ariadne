interface Ticket { readonly key: string; readonly dispatch: () => void }

/** One bounded dispatch budget for visible Message and Inbox bodies. Durable
 * address/generation checks remain in their read owners when a ticket runs. */
export class ProjectionBodyReadQueue {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queue: Ticket[] = [];
  private active = 0;
  read(key: string, operation: () => Promise<void>): Promise<void> {
    const pending = this.pending.get(key); if (pending !== undefined) return pending;
    if (this.pending.size >= 32) return Promise.reject(new Error('projection_body_queue_capacity_exceeded'));
    const result = new Promise<void>((resolve, reject) => {
      this.queue.push({ key, dispatch: () => {
        this.active++;
        void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          this.active--; this.pending.delete(key); this.dispatch();
        });
      } });
    });
    this.pending.set(key, result); this.dispatch(); return result;
  }
  private dispatch(): void { while (this.active < 2 && this.queue.length > 0) this.queue.shift()!.dispatch(); }
}
