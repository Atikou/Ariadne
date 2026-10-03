/** Feature selectors return records of immutable slice references and scalar state. */
export function shallowSnapshotEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}
