import { describe, expect, it } from 'vitest';
import { calculateSelectMenuLayout, calculateSelectSubmenuLayout } from '../src/shared/select-menu-layout';

describe('SelectMenu viewport layout', () => {
  it('keeps a wide menu inside the right viewport edge', () => {
    const layout = calculateSelectMenuLayout({
      anchor: { top: 420, right: 228, bottom: 446, left: 120, width: 108 },
      naturalHeight: 170,
      preferredPlacement: 'top',
      minimumWidth: 170,
      viewportWidth: 240,
      viewportHeight: 500
    });

    expect(layout).toMatchObject({ left: 58, width: 170, placement: 'top' });
    expect(layout.left + layout.width).toBeLessThanOrEqual(232);
    expect(layout.top).toBeGreaterThanOrEqual(8);
  });

  it('flips placement and limits height when the preferred side cannot fit', () => {
    const layout = calculateSelectMenuLayout({
      anchor: { top: 28, right: 180, bottom: 56, left: 80, width: 100 },
      naturalHeight: 600,
      preferredPlacement: 'top',
      minimumWidth: 190,
      viewportWidth: 320,
      viewportHeight: 240
    });

    expect(layout.placement).toBe('bottom');
    expect(layout.maxHeight).toBe(170);
    expect(layout.top).toBe(62);
  });

  it('shrinks the menu width when the entire viewport is narrow', () => {
    const layout = calculateSelectMenuLayout({
      anchor: { top: 80, right: 90, bottom: 108, left: 20, width: 70 },
      naturalHeight: 90,
      preferredPlacement: 'bottom',
      minimumWidth: 190,
      viewportWidth: 150,
      viewportHeight: 300
    });

    expect(layout).toMatchObject({ left: 8, width: 134 });
  });

  it('opens a submenu beside its option and flips it away from the right edge', () => {
    const right = calculateSelectSubmenuLayout({
      anchor: { top: 120, right: 180, bottom: 150, left: 20, width: 160 },
      naturalHeight: 136,
      minimumWidth: 190,
      viewportWidth: 520,
      viewportHeight: 400
    });
    const left = calculateSelectSubmenuLayout({
      anchor: { top: 300, right: 500, bottom: 330, left: 340, width: 160 },
      naturalHeight: 136,
      minimumWidth: 190,
      viewportWidth: 520,
      viewportHeight: 400
    });

    expect(right).toMatchObject({ direction: 'right', left: 184, top: 120, width: 190 });
    expect(left).toMatchObject({ direction: 'left', left: 146, top: 256, width: 190 });
    expect(left.left).toBeGreaterThanOrEqual(8);
    expect(left.left + left.width).toBeLessThanOrEqual(512);
  });
});
