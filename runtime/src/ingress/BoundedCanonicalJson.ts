const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_CHARACTERS = 1_000_000;

export interface BoundedCanonicalJsonOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxCharacters?: number;
}

interface CanonicalJsonBudget {
  nodes: number;
  characters: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxCharacters: number;
}

/**
 * Produces deterministic JSON without invoking getters or accepting values
 * whose JSON.stringify behavior is lossy or implementation-defined.
 */
export function boundedCanonicalJson(
  value: unknown,
  options: BoundedCanonicalJsonOptions = {}
): string {
  const budget: CanonicalJsonBudget = {
    nodes: 0,
    characters: 0,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxCharacters: options.maxCharacters ?? DEFAULT_MAX_CHARACTERS
  };
  assertPositiveLimit(budget.maxDepth, 'max_depth');
  assertPositiveLimit(budget.maxNodes, 'max_nodes');
  assertPositiveLimit(budget.maxCharacters, 'max_characters');
  const canonical = canonicalize(value, new Set<object>(), budget, 0);
  if (canonical.length > budget.maxCharacters) {
    throw new Error('canonical_json_output_too_large');
  }
  return canonical;
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  budget: CanonicalJsonBudget,
  depth: number
): string {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) throw new Error('canonical_json_node_limit_exceeded');
  if (depth > budget.maxDepth) throw new Error('canonical_json_depth_limit_exceeded');

  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      addCharacters(budget, value.length);
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical_json_non_finite_number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'undefined':
      throw new Error('canonical_json_undefined_value');
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error('canonical_json_unsupported_value');
    case 'object':
      break;
  }

  if (ancestors.has(value)) throw new Error('canonical_json_cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalizeArray(value, ancestors, budget, depth);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical_json_non_plain_object');
    }
    return canonicalizeRecord(value, ancestors, budget, depth);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeArray(
  value: unknown[],
  ancestors: Set<object>,
  budget: CanonicalJsonBudget,
  depth: number
): string {
  if (value.length > budget.maxNodes) throw new Error('canonical_json_node_limit_exceeded');
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
      throw new Error('canonical_json_array_property_invalid');
    }
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new Error('canonical_json_sparse_or_accessor_array');
    }
    items.push(canonicalize(
      descriptor.value,
      ancestors,
      budget,
      depth + 1
    ));
  }
  return `[${items.join(',')}]`;
}

function canonicalizeRecord(
  value: object,
  ancestors: Set<object>,
  budget: CanonicalJsonBudget,
  depth: number
): string {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('canonical_json_symbol_key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      throw new Error('canonical_json_non_plain_property');
    }
    if (descriptor.value === undefined) throw new Error('canonical_json_undefined_value');
    addCharacters(budget, key.length);
    entries.push({ key, value: descriptor.value });
  }
  entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return `{${entries.map((entry) => (
    `${JSON.stringify(entry.key)}:${canonicalize(
      entry.value,
      ancestors,
      budget,
      depth + 1
    )}`
  )).join(',')}}`;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function addCharacters(budget: CanonicalJsonBudget, count: number): void {
  budget.characters += count;
  if (budget.characters > budget.maxCharacters) {
    throw new Error('canonical_json_character_limit_exceeded');
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`canonical_json_${name}_invalid`);
  }
}
