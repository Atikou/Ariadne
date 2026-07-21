export interface RulerEntry<T> {
  node: T;
  emphasisLevel: number;
}

export function resolveRulerCurrentId<T extends { id: string }>(
  nodes: readonly T[],
  activeId: string | null,
  selectedId: string | null
): string | null {
  const availableIds = new Set(nodes.map((node) => node.id));
  return [activeId, selectedId].find((id) => id !== null && availableIds.has(id)) ?? null;
}

export function createRulerEntries<T extends { id: string }>(
  nodes: readonly T[],
  emphasizedId: string | null
): readonly RulerEntry<T>[] {
  const emphasizedIndex = emphasizedId
    ? nodes.findIndex((node) => node.id === emphasizedId)
    : -1;

  return nodes.map((node, index) => ({
    node,
    emphasisLevel: emphasizedIndex < 0
      ? 0
      : Math.max(0, 4 - Math.abs(index - emphasizedIndex))
  }));
}
