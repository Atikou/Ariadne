import { DOCKVIEW_POPOUT_PATH } from '@shared/windowing';

export function isTrustedDockviewPopoutUrl(rendererUrl: string, candidateUrl: string): boolean {
  try {
    const renderer = new URL(rendererUrl);
    const candidate = new URL(candidateUrl);
    return candidate.origin === renderer.origin
      && candidate.pathname === DOCKVIEW_POPOUT_PATH
      && candidate.search === ''
      && candidate.hash === '';
  } catch {
    return false;
  }
}

export function isCurrentDocumentNavigation(currentUrl: string, candidateUrl: string): boolean {
  try {
    return new URL(candidateUrl).href === new URL(currentUrl).href;
  } catch {
    return false;
  }
}
