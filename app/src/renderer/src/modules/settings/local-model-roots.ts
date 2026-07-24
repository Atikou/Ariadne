export function createEditableLocalModelRoots(values: readonly string[]): string[] {
  return values.length > 0 ? [...values] : [''];
}

export function normalizeLocalModelRoots(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean);
}

export function moveLocalModelRoot(values: readonly string[], fromIndex: number, toIndex: number): string[] {
  const next = [...values];
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= next.length
    || toIndex >= next.length
  ) return next;

  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return next;
  next.splice(toIndex, 0, moved);
  return next;
}
