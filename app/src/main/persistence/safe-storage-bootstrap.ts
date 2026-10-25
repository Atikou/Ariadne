import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Chromium's Windows safeStorage key is a DPAPI-wrapped random profile key.
 * It is first scheduled into Local State, not synchronously persisted by
 * encryptString. Do not acknowledge dependent encrypted files before that
 * owning profile-key record exists durably. Never create/replace its contents. */
export async function awaitDurableWindowsStorageKey(sessionDataPath: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(join(sessionDataPath, 'Local State'), 'r+');
      const size = (await file.stat()).size;
      if (size > 1024 * 1024) throw new Error('safe_storage_profile_state_capacity_exceeded');
      const state: unknown = JSON.parse(await file.readFile('utf8'));
      if (hasProtectedWindowsStorageKey(state)) { await file.sync(); return; }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') && !(error instanceof SyntaxError))
        throw new Error('safe_storage_profile_key_unavailable');
    } finally { await file?.close(); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('safe_storage_profile_key_not_durable');
}
export function hasProtectedWindowsStorageKey(state: unknown): boolean {
  if (!state || typeof state !== 'object' || !('os_crypt' in state)) return false;
  const crypt = state.os_crypt;
  if (!crypt || typeof crypt !== 'object' || !('encrypted_key' in crypt) || typeof crypt.encrypted_key !== 'string') return false;
  const encoded = crypt.encrypted_key;
  if (!encoded || encoded.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return false;
  const wrapped = Buffer.from(encoded, 'base64');
  return wrapped.length > 5 && wrapped.subarray(0, 5).equals(Buffer.from('DPAPI'));
}
