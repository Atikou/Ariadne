export interface ScreenPoint {
  x: number;
  y: number;
}

export interface WindowFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isScreenPointOutsideWindow(point: ScreenPoint, frame: WindowFrame): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (point.x === 0 && point.y === 0) return false;
  return point.x < frame.left
    || point.y < frame.top
    || point.x > frame.left + frame.width
    || point.y > frame.top + frame.height;
}
