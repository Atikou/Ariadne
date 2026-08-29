import { describe, expect, it } from 'vitest';

import {
  titleBarOverlayForTheme,
  windowBackgroundForTheme
} from '../src/main/windows/title-bar-appearance';

describe('native title bar appearance', () => {
  it.each(['dark', 'light'] as const)(
    'keeps the Windows controls surface transparent in %s mode',
    (theme) => {
      expect(titleBarOverlayForTheme(theme)).toMatchObject({
        color: 'rgba(0, 0, 0, 0)',
        height: 44
      });
    }
  );

  it('keeps theme-specific symbols and BrowserWindow fallback backgrounds', () => {
    expect(titleBarOverlayForTheme('dark').symbolColor).toBe('#d9dde7');
    expect(titleBarOverlayForTheme('light').symbolColor).toBe('#252832');
    expect(windowBackgroundForTheme('dark')).toBe('#0d0f13');
    expect(windowBackgroundForTheme('light')).toBe('#eceef2');
  });
});
