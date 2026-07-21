import type { GameActivitySnapshot, ShowWindowRequest, UserPreferences } from '@shared/contract';

export interface InterruptionDecision {
  allow: boolean;
  allowTemporaryTopmost: boolean;
  reason?: string;
}

export class InterruptionPolicy {
  evaluate(
    request: ShowWindowRequest,
    activity: GameActivitySnapshot,
    preferences: UserPreferences
  ): InterruptionDecision {
    if (request.source === 'user') {
      return { allow: true, allowTemporaryTopmost: request.allowTemporaryTopmost };
    }

    if (preferences.suppressAutomaticWakeDuringGames && activity.status === 'active') {
      return {
        allow: false,
        allowTemporaryTopmost: false,
        reason: 'Automatic wake was suppressed while game activity is detected.'
      };
    }

    return {
      allow: true,
      allowTemporaryTopmost: request.allowTemporaryTopmost && activity.status === 'inactive'
    };
  }
}
