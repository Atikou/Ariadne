import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitDurableWindowsStorageKey, hasProtectedWindowsStorageKey } from '../src/main/persistence/safe-storage-bootstrap';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { const scope = relative(tmpdir(), root);
  if (!scope || scope.startsWith('..') || isAbsolute(scope)) throw new Error('unsafe_test_cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'ariadne-cipher-bootstrap-')); roots.push(root); return root; }
const protectedKey = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIwrapped-test-key').toString('base64') }, other: 'preserved' });
describe('profile-key durability before encrypted repository acknowledgement', () => {
  it('recognizes only a bounded protected Windows key record', () => {
    expect(hasProtectedWindowsStorageKey(JSON.parse(protectedKey))).toBe(true);
    expect(hasProtectedWindowsStorageKey({ os_crypt: { encrypted_key: 'plaintext-key' } })).toBe(false);
    expect(hasProtectedWindowsStorageKey({ os_crypt: { encrypted_key: Buffer.from('DPAPI').toString('base64') } })).toBe(false);
    expect(hasProtectedWindowsStorageKey(null)).toBe(false);
  });
  it('waits for Chromium to persist its own key and does not fabricate Local State', async () => {
    const root = await fixture(); let acknowledged = false;
    const pending = awaitDurableWindowsStorageKey(root, 1000).then(() => { acknowledged = true; });
    await new Promise(resolve => setTimeout(resolve, 25)); expect(acknowledged).toBe(false);
    await expect(readFile(join(root, 'Local State'))).rejects.toThrow();
    await writeFile(join(root, 'Local State'), protectedKey); await pending;
    expect(await readFile(join(root, 'Local State'), 'utf8')).toBe(protectedKey);
  });
  it('refuses to acknowledge an absent or invalid key without altering its owner file', async () => {
    const root = await fixture(); const original = '{"os_crypt":{}}'; await writeFile(join(root, 'Local State'), original);
    await expect(awaitDurableWindowsStorageKey(root, 20)).rejects.toThrow('key_not_durable');
    expect(await readFile(join(root, 'Local State'), 'utf8')).toBe(original);
  });
  it('rejects a wrong owner path rather than turning it into a new key file', async () => {
    const root = await fixture(); await mkdir(join(root, 'Local State'));
    await expect(awaitDurableWindowsStorageKey(root, 20)).rejects.toThrow('key_unavailable');
  });
});
