export interface RuntimeCommandContext {
  readonly commandId: string;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
}

export function assertRuntimeCommandActive(context: RuntimeCommandContext): void {
  context.signal.throwIfAborted();
  if (Date.parse(context.deadlineAt) <= Date.now()) {
    throw new Error('deadline_exceeded');
  }
}
