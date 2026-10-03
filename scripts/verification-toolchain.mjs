import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Ask the executing npm CLI; a parent npm exec can leave a stale user-agent string. */
export function detectedNpmVersion() {
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) return execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();
  return execFileSync(process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm --version'] : ['--version'], { encoding: 'utf8' }).trim();
}
