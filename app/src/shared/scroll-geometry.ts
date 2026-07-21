export function getNearestScrollDelta(
  viewportStart: number,
  viewportEnd: number,
  itemStart: number,
  itemEnd: number,
  padding = 0
): number {
  const visibleStart = viewportStart + padding;
  const visibleEnd = viewportEnd - padding;
  if (itemStart < visibleStart) return itemStart - visibleStart;
  if (itemEnd > visibleEnd) return itemEnd - visibleEnd;
  return 0;
}

export function getCenteredScrollDelta(
  viewportStart: number,
  viewportSize: number,
  itemStart: number,
  itemSize: number
): number {
  return itemStart - viewportStart - (viewportSize - itemSize) / 2;
}

export function isScrollNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 24
): boolean {
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold;
}
