export type SelectMenuPlacement = 'top' | 'bottom';

export interface SelectMenuAnchorBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
}

export interface SelectMenuLayout {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: SelectMenuPlacement;
}

export type SelectSubmenuDirection = 'left' | 'right';

export interface SelectSubmenuLayout {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  direction: SelectSubmenuDirection;
}

interface SelectMenuLayoutInput {
  anchor: SelectMenuAnchorBounds;
  naturalHeight: number;
  preferredPlacement: SelectMenuPlacement;
  minimumWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  gutter?: number;
}

export function calculateSelectMenuLayout({
  anchor,
  naturalHeight,
  preferredPlacement,
  minimumWidth,
  viewportWidth,
  viewportHeight,
  gap = 6,
  gutter = 8
}: SelectMenuLayoutInput): SelectMenuLayout {
  const availableWidth = Math.max(0, viewportWidth - gutter * 2);
  const width = Math.min(Math.max(anchor.width, minimumWidth), availableWidth);
  let left = anchor.left;
  if (left + width > viewportWidth - gutter) left = anchor.right - width;
  left = clamp(left, gutter, Math.max(gutter, viewportWidth - gutter - width));

  const spaceAbove = Math.max(0, anchor.top - gap - gutter);
  const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - gap - gutter);
  const preferredSpace = preferredPlacement === 'top' ? spaceAbove : spaceBelow;
  const alternateSpace = preferredPlacement === 'top' ? spaceBelow : spaceAbove;
  const placement = naturalHeight > preferredSpace && alternateSpace > preferredSpace
    ? opposite(preferredPlacement)
    : preferredPlacement;
  const maxHeight = placement === 'top' ? spaceAbove : spaceBelow;
  const visibleHeight = Math.min(naturalHeight, maxHeight);
  const top = placement === 'top'
    ? Math.max(gutter, anchor.top - gap - visibleHeight)
    : Math.min(anchor.bottom + gap, Math.max(gutter, viewportHeight - gutter - visibleHeight));

  return { top, left, width, maxHeight, placement };
}

interface SelectSubmenuLayoutInput {
  anchor: SelectMenuAnchorBounds;
  naturalHeight: number;
  minimumWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  gutter?: number;
}

export function calculateSelectSubmenuLayout({
  anchor,
  naturalHeight,
  minimumWidth,
  viewportWidth,
  viewportHeight,
  gap = 4,
  gutter = 8
}: SelectSubmenuLayoutInput): SelectSubmenuLayout {
  const availableWidth = Math.max(0, viewportWidth - gutter * 2);
  const width = Math.min(minimumWidth, availableWidth);
  const spaceRight = Math.max(0, viewportWidth - gutter - anchor.right - gap);
  const spaceLeft = Math.max(0, anchor.left - gap - gutter);
  const direction: SelectSubmenuDirection = spaceRight >= width || spaceRight >= spaceLeft
    ? 'right'
    : 'left';
  const desiredLeft = direction === 'right'
    ? anchor.right + gap
    : anchor.left - gap - width;
  const left = clamp(desiredLeft, gutter, Math.max(gutter, viewportWidth - gutter - width));
  const maxHeight = Math.max(0, viewportHeight - gutter * 2);
  const visibleHeight = Math.min(naturalHeight, maxHeight);
  const top = clamp(anchor.top, gutter, Math.max(gutter, viewportHeight - gutter - visibleHeight));

  return { top, left, width, maxHeight, direction };
}

function opposite(placement: SelectMenuPlacement): SelectMenuPlacement {
  return placement === 'top' ? 'bottom' : 'top';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
