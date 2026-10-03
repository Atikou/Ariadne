import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(root, '../..');
const output = path.join(project, 'artifacts/renderer-history');
await build({ configFile: false, root, base: './', resolve: { alias: {
  '@renderer': path.join(project, 'app/src/renderer/src'), '@shared': path.join(project, 'app/src/shared')
} }, esbuild: { jsx: 'automatic' }, build: { outDir: path.join(output, 'build'),
  emptyOutDir: false, rollupOptions: { input: path.join(root, 'renderer-history.html') } } });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const electron = createRequire(import.meta.url)('electron');
const runId = randomUUID();
const result = spawnSync(electron, [path.join(root, 'renderer-history.cjs'), output, runId], {
  cwd: project, env: environment, windowsHide: true, stdio: 'inherit', timeout: 150_000
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`renderer_history_benchmark_failed:${result.status}`);
const evidence = JSON.parse(readFileSync(path.join(output, 'renderer-performance.json'), 'utf8'));
if (evidence.runId !== runId || evidence.measurements.length !== 4 || evidence.measurements.some(item => !item.liveVisible)) {
  throw new Error('renderer_history_benchmark_missing_visible_updates');
}
const binding = spawnSync(process.execPath, [path.join(project, 'scripts/write-verification-evidence.mjs'),
  'artifacts/renderer-history/source-evidence.json', 'artifacts/renderer-history'], { cwd: project, stdio: 'inherit' });
if (binding.status !== 0) throw new Error('renderer_history_evidence_binding_failed');
console.log(`Renderer history benchmark passed: ${path.relative(project, output)}`);
