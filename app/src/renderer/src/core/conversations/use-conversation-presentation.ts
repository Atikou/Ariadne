import { useCallback, useSyncExternalStore } from 'react';
import type { ConversationNavigationService } from './conversation-navigation-service';

export function useConversationPresentationRevision(
  service: ConversationNavigationService
): number {
  const subscribe = useCallback(
    (listener: () => void) => service.onSessionPresentationChanged(listener),
    [service]
  );
  const getSnapshot = useCallback(
    () => service.getSessionPresentationRevision(),
    [service]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
