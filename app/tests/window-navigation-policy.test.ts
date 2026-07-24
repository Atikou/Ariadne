import { describe, expect, it } from 'vitest';
import { isTrustedDockviewPopoutUrl } from '../src/main/windows/window-navigation-policy';

describe('Dockview popout navigation policy', () => {
  const rendererUrl = 'https://ariadne.local/index.html';

  it('allows only the exact same-origin popout document', () => {
    expect(isTrustedDockviewPopoutUrl(rendererUrl, 'https://ariadne.local/popout.html')).toBe(true);
    expect(isTrustedDockviewPopoutUrl(rendererUrl, 'https://ariadne.local/popout.html?redirect=1')).toBe(false);
    expect(isTrustedDockviewPopoutUrl(rendererUrl, 'https://example.com/popout.html')).toBe(false);
    expect(isTrustedDockviewPopoutUrl(rendererUrl, 'javascript:alert(1)')).toBe(false);
  });
});
