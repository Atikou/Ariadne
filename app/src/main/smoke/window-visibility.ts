import { screen, type BrowserWindow } from 'electron';

/** Visibility-driven UI must run on a display; off-screen reloads suspend
 * Chromium intersection callbacks even when background throttling is disabled. */
export function showSmokeWindow(window: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = window.getBounds();
  window.setBounds({ x: area.x, y: area.y, width: Math.min(bounds.width, area.width),
    height: Math.min(bounds.height, area.height) }, false);
  window.setSkipTaskbar(true);
  window.show();
}
