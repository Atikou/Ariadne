/** Bound live token rendering to one update per frame-sized interval. Durable changes flush immediately. */
export class LiveSnapshotPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly publish: () => void) {}
  schedule(): void {
    this.timer ??= setTimeout(() => { this.timer = undefined; this.publish(); }, 16);
  }
  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
