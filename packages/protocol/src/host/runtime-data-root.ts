/** One lexical identity shared by bootstrap and private storage maintenance. */
export function isCanonicalAbsoluteDataRoot(value: string): boolean {
  if (value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/')) {
    if (value === '/') return true;
    if (value.endsWith('/') || value.includes('//')) return false;
    return value.slice(1).split('/').every(segment => segment !== '.' && segment !== '..');
  }
  if (/^[A-Za-z]:\\/u.test(value)) {
    if (value.length === 3) return true;
    if (value.endsWith('\\') || value.includes('/') || value.slice(3).includes('\\\\')) return false;
    return value.slice(3).split('\\').every(isCanonicalWindowsPathSegment);
  }
  if (value.startsWith('\\\\')) {
    if (value.endsWith('\\') || value.includes('/') || value.slice(2).includes('\\\\')) return false;
    const segments = value.slice(2).split('\\');
    return segments.length >= 2 && segments.every(isCanonicalWindowsPathSegment);
  }
  return false;
}
export function assertCanonicalAbsoluteDataRoot(value: string): void {
  if (!isCanonicalAbsoluteDataRoot(value)) throw new Error('runtime_bootstrap_data_root_not_canonical_absolute');
}
function isCanonicalWindowsPathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !/[<>:"|?*]/u.test(segment) && !/[ .]$/u.test(segment);
}
