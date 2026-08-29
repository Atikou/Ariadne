import type { TitleBarOverlay } from 'electron';
import type { ThemePreference } from '@shared/contract';

export type EffectiveTitleBarTheme = Exclude<ThemePreference, 'system'>;

const TRANSPARENT_WINDOW_CONTROLS_BACKGROUND = 'rgba(0, 0, 0, 0)';
const TITLE_BAR_HEIGHT = 44;

/**
 * The native Windows controls sit above the Renderer. Their surface must stay
 * transparent so Renderer-owned scrims and title-bar colors remain continuous.
 */
export function titleBarOverlayForTheme(theme: EffectiveTitleBarTheme): TitleBarOverlay {
  return {
    color: TRANSPARENT_WINDOW_CONTROLS_BACKGROUND,
    symbolColor: theme === 'dark' ? '#d9dde7' : '#252832',
    height: TITLE_BAR_HEIGHT
  };
}

export function windowBackgroundForTheme(theme: EffectiveTitleBarTheme): string {
  return theme === 'dark' ? '#0d0f13' : '#eceef2';
}
