export interface ComposerTextareaLayout {
  height: number;
  overflowY: 'hidden' | 'auto';
}

export function calculateComposerTextareaLayout(
  contentHeight: number,
  minimumHeight: number,
  maximumHeight: number
): ComposerTextareaLayout {
  const safeMinimum = finiteNonNegative(minimumHeight);
  const safeMaximum = Math.max(safeMinimum, finiteNonNegative(maximumHeight, safeMinimum));
  const safeContent = finiteNonNegative(contentHeight, safeMinimum);
  return {
    height: Math.min(Math.max(safeContent, safeMinimum), safeMaximum),
    overflowY: safeContent > safeMaximum ? 'auto' : 'hidden'
  };
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
