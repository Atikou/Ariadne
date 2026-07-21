export interface EdgeTabClickContext {
  isEdgeGroup: boolean;
  isTabAction: boolean;
  setActive(): void;
  expand(): void;
}

export function activateEdgeTab(context: EdgeTabClickContext): boolean {
  if (!context.isEdgeGroup || context.isTabAction) return false;
  context.setActive();
  context.expand();
  return true;
}
