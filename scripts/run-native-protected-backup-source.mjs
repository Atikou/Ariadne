import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const evidence = process.argv[2];
if (!evidence || !path.isAbsolute(evidence)) throw new Error('native_source_evidence_absolute_required');
const scope = path.relative(path.join(project, 'artifacts', 'todo-remediation'), evidence);
if (!scope || scope.startsWith('..') || path.isAbsolute(scope)) throw new Error('native_source_evidence_scope_invalid');
const source = await realpath(await mkdtemp(path.join(tmpdir(), 'AriadneDomainHealth-Protected-')));
const helper = await realpath(await mkdtemp(path.join(tmpdir(), 'AriadneNativeBackupHelper-')));
const destination = path.join(helper, 'backups'), staging = path.join(helper, 'staging');
await mkdir(destination); await mkdir(staging);
await writeFile(evidence, JSON.stringify({ source, helper, destination, staging, state: 'started' }, null, 2));
const entry = path.join(helper, 'source.cjs'), coreEntry = path.join(helper, 'core.cjs'), sharp = require.resolve('sharp');
await build({ entryPoints: [path.join(project, 'app', 'tests', 'fixtures', 'electron-protected-recovery-source.ts')],
  outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  alias: { '@shared': path.join(project, 'app', 'src', 'shared'), sharp }, external: ['electron', sharp], logLevel: 'silent' });
await build({ entryPoints: [path.join(project, 'app', 'tests', 'fixtures', 'node-protected-recovery-source.ts')], outfile: coreEntry,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { sharp }, external: [sharp], logLevel: 'silent' });
const result = await new Promise((resolve, reject) => {
  const child = spawn(path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe'), [entry, source,
    path.join(project, 'runtime', 'dist', 'entry', 'runtime-process.js'), process.execPath, destination, staging, coreEntry],
    { cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  let response = null; const timer = setTimeout(() => child.kill(), 120000), diagnosticCodes = new Set();
  child.stdout.resume(); child.stderr.on('data', chunk => {
    // Codes only from this fresh synthetic fixture, never raw native logs,
    // key ids, ciphertext, payloads, paths or credential strings.
    for (const code of chunk.toString('utf8').match(/\b(?:agent|conversation|runtime|model|projection|productivity)_[a-z_]+\b/gu) ?? [])
      if (diagnosticCodes.size < 32) diagnosticCodes.add(code);
  }); child.on('message', value => { response = value; });
  child.on('error', reject); child.on('close', code => { clearTimeout(timer);
    if (code !== 0 || !response?.ok) {
      const phase = response?.phase ?? 'process';
      void writeFile(evidence, JSON.stringify({ source, helper, destination, staging, state: 'failed', code, phase,
        diagnosticCode: response?.diagnosticCode ?? 'process_failed', diagnosticCodes: [...diagnosticCodes] }, null, 2))
        .then(() => reject(new Error('native_protected_source_failed:' + phase)), reject); return;
    } resolve(response); });
});
// Retain evidence and source for an independent recovery process. No plaintext
// credential/key/payload is serialized by this driver.
await writeFile(evidence, JSON.stringify({ source, helper, destination, staging, result }, null, 2));
process.stdout.write(JSON.stringify({ source, evidence, published: result.published, productionRuntime: true }) + '\n');
