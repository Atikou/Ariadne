import type { AgentSettingsEffect } from '@shared/contract';

export function shouldRestartRuntimeForAgentSettings(effect: AgentSettingsEffect): boolean {
  return effect === 'restart_required';
}
