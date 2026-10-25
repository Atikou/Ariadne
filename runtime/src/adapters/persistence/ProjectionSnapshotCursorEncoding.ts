/** Opaque cursor bytes must not randomly acquire a plaintext credential shape.
 * Each segment is one prefixed word, with reversible URL-alphabet escaping.
 * Plaintext safety checks still inspect every response field unchanged. */
export function encodeProjectionCursorBytes(value: Uint8Array): string {
  return `c1_${Buffer.from(value).toString('base64url').replace(/[_-]/gu, value => value === '_' ? '_u' : '_h')}`;
}
export function decodeProjectionCursorBytes(value: string): Buffer | null {
  if (!/^c1_(?:[A-Za-z0-9]|_[uh])*$/u.test(value)) return null;
  const encoded = value.slice(3).replace(/_[uh]/gu, value => value === '_u' ? '_' : '-');
  const decoded = Buffer.from(encoded, 'base64url');
  return encodeProjectionCursorBytes(decoded) === value ? decoded : null;
}
