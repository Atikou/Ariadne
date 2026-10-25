import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RestrictedProcessRunner } from '../src/sandbox/RestrictedProcessRunner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string { const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-restricted-process-')); roots.push(root); return root; }
describe('retained restricted process admission', () => {
  it('rejects an already cancelled request before its executable can write anything', async () => {
    const root = workspace(); const target = path.join(root, 'forbidden-effect.txt'); const controller = new AbortController(); controller.abort(new Error('cancel_before_spawn'));
    await expect(new RestrictedProcessRunner().runFile({ file: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'must not execute')", target], cwd: root, timeoutMs: 5_000, maxOutputBytes: 1_024, signal: controller.signal })).rejects.toThrow('cancel_before_spawn');
    expect(existsSync(target)).toBe(false);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid time bounds before spawning: %s', timeoutMs => {
    return expect(new RestrictedProcessRunner().runFile({ file: 'must-not-launch', cwd: workspace(), timeoutMs, maxOutputBytes: 1_024 })).rejects.toThrow('restricted_process_timeout_invalid');
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects invalid output bounds before spawning: %s', maxOutputBytes => {
    return expect(new RestrictedProcessRunner().runFile({ file: 'must-not-launch', cwd: workspace(), timeoutMs: 5_000, maxOutputBytes })).rejects.toThrow('restricted_process_output_limit_invalid');
  });
  it('retains bounded real child output and reports truncation', async () => {
    const result = await new RestrictedProcessRunner().runFile({ file: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(8192))"], cwd: workspace(), timeoutMs: 5_000, maxOutputBytes: 128 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, truncated: true, spawnFailed: false });
    expect(Buffer.byteLength(result.stdout)).toBe(128); expect(result.stderr).toBe('');
  });
});
