import type { RuntimeCommand } from '@ariadne/protocol/public';

export function runtimeRequestErrorMessage(error: unknown, fallback = 'Runtime 请求失败。'): string {
  const source = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = source
    .replace(/^Error invoking remote method '[^']+':\s*/iu, '')
    .replace(/^(?:(?:RuntimeRequestError|Error):\s*)+/iu, '')
    .replace(/decision-action\.v1:[0-9a-f]{64}/giu, '[redacted-decision-action]')
    .trim();
  return (message || fallback).slice(0, 16_384);
}
export function sanitizeRuntimeCommandError(command: RuntimeCommand, error: unknown): unknown {
  return command.kind === 'agent.decision.resolve' ? new Error(runtimeRequestErrorMessage(error)) : error;
}
