import { screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import type { PersistedState } from '../persistence/state-schema';

const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 860;

export function resolveWindowOptions(saved: PersistedState['window']): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y'
> {
  if (saved.bounds && isVisible(saved.bounds)) return saved.bounds;
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function isVisible(bounds: Rectangle): boolean {
  const minimumVisible = 80;
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(
      0,
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y)
    );
    return overlapWidth >= minimumVisible && overlapHeight >= minimumVisible;
  });
}
