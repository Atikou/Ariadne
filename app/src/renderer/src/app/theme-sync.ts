import type { ThemePreference } from '@shared/contract';

export type EffectiveTheme = Exclude<ThemePreference, 'system'>;

export interface ThemeDocument {
  documentElement: {
    dataset: { theme?: string };
    style: { colorScheme: string };
  };
}

export function resolveEffectiveTheme(preference: ThemePreference, systemPrefersDark: boolean): EffectiveTheme {
  return preference === 'system'
    ? systemPrefersDark ? 'dark' : 'light'
    : preference;
}

export function applyThemeToDocument(target: ThemeDocument, theme: EffectiveTheme): void {
  target.documentElement.dataset.theme = theme;
  target.documentElement.style.colorScheme = theme;
}

export function applyThemeToWindow(target: Window, theme: EffectiveTheme): boolean {
  if (target.closed) return false;
  try {
    applyThemeToDocument(target.document, theme);
    return true;
  } catch {
    return false;
  }
}
