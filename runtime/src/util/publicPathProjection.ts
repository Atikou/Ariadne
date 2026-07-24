export interface PublicPathRoot {
  root: string | undefined;
  label: string;
}

interface CompiledPathRoot {
  pattern: RegExp;
  label: string;
  length: number;
}

export function createPublicPathProjector(
  roots: readonly PublicPathRoot[],
): (value: unknown) => unknown {
  const compiledRoots = compilePathRoots(roots);
  return (value) => projectValue(value, compiledRoots);
}

function compilePathRoots(roots: readonly PublicPathRoot[]): CompiledPathRoot[] {
  const seen = new Set<string>();
  const compiled: CompiledPathRoot[] = [];
  for (const entry of roots) {
    const normalized = entry.root?.trim().replace(/[\\/]+$/, "");
    if (!normalized) continue;
    const identity = normalized.replace(/\\/g, "/").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    compiled.push({
      pattern: new RegExp(`${pathPattern(normalized)}(?=$|[\\\\/])`, "gi"),
      label: entry.label,
      length: normalized.length,
    });
  }
  return compiled.sort((left, right) => right.length - left.length);
}

function pathPattern(value: string): string {
  const leadingSeparator = /^[\\/]/.test(value) ? "[\\\\/]" : "";
  const parts = value.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
  return `${leadingSeparator}${parts.join("[\\\\/]")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectValue(value: unknown, roots: readonly CompiledPathRoot[]): unknown {
  if (typeof value === "string") return projectString(value, roots);
  if (Array.isArray(value)) return value.map((item) => projectValue(item, roots));
  if (value !== null && typeof value === "object") {
    const projected = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const projectedKey = projectString(key, roots);
      let uniqueKey = projectedKey;
      let suffix = 2;
      while (Object.hasOwn(projected, uniqueKey)) {
        uniqueKey = `${projectedKey}#${suffix}`;
        suffix += 1;
      }
      projected[uniqueKey] = projectValue(item, roots);
    }
    return projected;
  }
  return value;
}

function projectString(value: string, roots: readonly CompiledPathRoot[]): string {
  return roots.reduce(
    (current, root) => current.replace(root.pattern, root.label),
    value,
  );
}
