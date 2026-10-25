import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

export interface BackupKeyProtector {
  protect(key: Buffer): Promise<string>;
  unprotect(wrapped: string): Promise<Buffer>;
}

/** Wraps only the random backup data key with Windows CurrentUser DPAPI.
 * It is independent of Chromium's Local State, which may itself need restoring.
 * Fixed OS code receives bytes over stdin; keys never enter command arguments,
 * Renderer, diagnostic logs or temporary plaintext files. No insecure fallback. */
export class WindowsBackupKeyProtector implements BackupKeyProtector {
  async protect(key: Buffer): Promise<string> {
    if (key.length !== 32) throw new Error('backup_data_key_invalid');
    return (await this.transform('Protect', key)).toString('base64');
  }
  async unprotect(wrapped: string): Promise<Buffer> {
    if (wrapped.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(wrapped))
      throw new Error('backup_wrapped_key_invalid');
    const bytes = Buffer.from(wrapped, 'base64');
    if (bytes.length < 32 || bytes.toString('base64') !== wrapped) throw new Error('backup_wrapped_key_invalid');
    const key = await this.transform('Unprotect', bytes);
    if (key.length !== 32) { key.fill(0); throw new Error('backup_data_key_invalid'); }
    return key;
  }
  private transform(operation: 'Protect' | 'Unprotect', bytes: Buffer): Promise<Buffer> {
    if (process.platform !== 'win32' || !process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))
      return Promise.reject(new Error('backup_windows_key_protection_unavailable'));
    const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference='Stop';try {
      Add-Type -AssemblyName System.Security;
      $taskInput=[Convert]::FromBase64String([Console]::In.ReadToEnd());
      $taskEntropy=[Text.Encoding]::UTF8.GetBytes('Ariadne same-machine backup data key v1');
      $taskResult=[Security.Cryptography.ProtectedData]::${operation}($taskInput,$taskEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
      [Console]::Out.Write([Convert]::ToBase64String($taskResult));
      [Array]::Clear($taskInput,0,$taskInput.Length);[Array]::Clear($taskResult,0,$taskResult.Length);
    }catch {exit 2}`;
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() }
      });
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const fail = (): void => {
        if (settled) return; settled = true; clearTimeout(timer); child.kill();
        for (const chunk of chunks) chunk.fill(0);
        reject(new Error('backup_windows_key_protection_failed'));
      };
      const timer = setTimeout(fail, 15_000);
      child.on('error', fail); child.stdin.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) { chunk.fill(0); return; }
        size += chunk.length; chunks.push(chunk); if (size > 16_384) fail();
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { fail(); return; }
        const output = Buffer.concat(chunks).toString('ascii');
        for (const chunk of chunks) chunk.fill(0);
        if (!output || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(output)) { fail(); return; }
        const result = Buffer.from(output, 'base64');
        if (result.toString('base64') !== output) { result.fill(0); fail(); return; }
        settled = true; clearTimeout(timer); resolve(result);
      });
      child.stdin.end(bytes.toString('base64'));
    });
  }
}
