export function stableToolInputKey(tool: string, input: Record<string, unknown>): string {
  const sorted = Object.keys(input)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = input[key];
      return acc;
    }, {});
  return `${tool}:${JSON.stringify(sorted)}`;
}

export function stepInputKey(tool: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  return stableToolInputKey(tool, record);
}
