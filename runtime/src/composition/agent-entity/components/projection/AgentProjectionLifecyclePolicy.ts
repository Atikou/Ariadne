export function projectionHealthError(cause: unknown): Error {
  return new Error('agent_control_public_projection_unhealthy', { cause });
}

export function assertPublishInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new Error('agent_control_public_projection_interval_invalid');
  }
}
