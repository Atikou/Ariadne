import type { PublicDecisionChoice, PublicDecisionProjection } from '@ariadne/protocol/public';
import type { RuntimeRun } from '../runtime-projection-presenter';

/** Visible recovery actions must respect both the pending Decision and the Run stop intent. */
export function recoveryActionChoices(run: RuntimeRun, decisions: readonly PublicDecisionProjection[]): readonly PublicDecisionChoice[] {
  if (run.origin !== 'projection') return [];
  const recovery = decisions.find(candidate => candidate.runId === run.runId
    && candidate.kind === 'recovery' && candidate.status === 'pending');
  return (recovery?.action?.choices ?? []).filter(choice => !(run.cancellationPending === true && choice === 'retry'));
}
