import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectedNpmVersion } from './verification-toolchain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] ?? 'artifacts/verification-evidence.json');
if (!output.startsWith(path.join(root, 'artifacts') + path.sep)) throw new Error('evidence_output_outside_artifacts');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))]
  .filter(file => existsSync(path.join(root, file))).sort();
const source = createHash('sha256');
for (const file of files) {
  if (!lstatSync(path.join(root, file)).isFile()) throw new Error('source_snapshot_requires_regular_files');
  source.update(file.replaceAll('\\', '/') + '\0').update(hash(readFileSync(path.join(root, file))) + '\0');
}
const results = [];
function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && ['profile-window.json', 'electron-runtime-smoke.json', 'desktop-restart-delivery.json', 'renderer-performance.json'].includes(entry.name)) {
      const bytes = readFileSync(file);
      const result = JSON.parse(bytes);
      results.push({ file: path.relative(root, file).replaceAll('\\', '/'), sha256: hash(bytes),
        passed: result.passed, profileId: result.profileId, profileDigest: result.profileDigest });
    }
  }
}
const directories = process.argv.slice(3);
for (const directory of directories.length ? directories : ['artifacts/electron-runtime-smoke', 'artifacts/electron-profile-matrix']) {
  const absolute = path.resolve(root, directory);
  if (!absolute.startsWith(path.join(root, 'artifacts') + path.sep)) throw new Error('evidence_input_outside_artifacts');
  collect(absolute);
}
const npmVersion = detectedNpmVersion();
const electronPackage = path.join(root, 'node_modules/electron/package.json');
const evidence = { schema: 'ariadne.verification-evidence.v1', capturedAt: new Date().toISOString(),
  source: { head: git(['rev-parse', 'HEAD']).trim(), dirty: git(['status', '--porcelain=v1']).trim() !== '',
    fileCount: files.length, contentSha256: source.digest('hex') },
  toolchain: { node: process.versions.node, npm: npmVersion, platform: process.platform, architecture: process.arch,
    electron: existsSync(electronPackage) ? JSON.parse(readFileSync(electronPackage, 'utf8')).version : null },
  ci: { job: process.env.GITHUB_JOB ?? null, runId: process.env.GITHUB_RUN_ID ?? null }, results };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Verification evidence written: ${path.relative(root, output)}`);
