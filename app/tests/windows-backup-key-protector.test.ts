import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WindowsBackupKeyProtector } from '../src/main/runtime/windows-backup-key-protector';

describe.skipIf(process.platform !== 'win32')('actual Windows backup data-key protection', () => {
  it('round-trips through CurrentUser DPAPI independently of an Electron profile and rejects damaged wrapping', async () => {
    const key = randomBytes(32);
    try {
      const wrapped = await new WindowsBackupKeyProtector().protect(key);
      expect(Buffer.from(wrapped, 'base64').length).toBeGreaterThan(key.length);
      expect(wrapped).not.toBe(key.toString('base64'));
      const restored = await new WindowsBackupKeyProtector().unprotect(wrapped);
      try { expect(restored.equals(key)).toBe(true); } finally { restored.fill(0); }
      const damaged = Buffer.from(wrapped, 'base64'); damaged[Math.floor(damaged.length / 2)]! ^= 1;
      await expect(new WindowsBackupKeyProtector().unprotect(damaged.toString('base64')))
        .rejects.toThrow('backup_windows_key_protection_failed');
      await expect(new WindowsBackupKeyProtector().unprotect('../not-a-key')).rejects.toThrow('backup_wrapped_key_invalid');
    } finally { key.fill(0); }
  }, 30_000);
});
