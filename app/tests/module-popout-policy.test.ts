import { describe, expect, it } from 'vitest';
import { isScreenPointOutsideWindow } from '../src/renderer/src/app/module-popout-policy';

describe('module popout drop policy', () => {
  const frame = { left: 100, top: 80, width: 900, height: 640 };

  it('opens a popout only after a tab leaves the current native window', () => {
    expect(isScreenPointOutsideWindow({ x: 120, y: 100 }, frame)).toBe(false);
    expect(isScreenPointOutsideWindow({ x: 1_000, y: 720 }, frame)).toBe(false);
    expect(isScreenPointOutsideWindow({ x: 1_001, y: 300 }, frame)).toBe(true);
    expect(isScreenPointOutsideWindow({ x: 50, y: 300 }, frame)).toBe(true);
  });

  it('does not treat the zero coordinates emitted by a cancelled drag as a popout', () => {
    expect(isScreenPointOutsideWindow({ x: 0, y: 0 }, frame)).toBe(false);
  });
});
