import { build } from 'vite';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('smoke_probe_destination_must_be_absolute');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
await build({ configFile: false, resolve: { alias: { '@shared': resolve(projectRoot, 'app/src/shared') } },
  build: { lib: { entry: resolve(projectRoot, 'scripts/smoke/projection-probe.ts'), name: 'AriadneSmokeProjection',
    formats: ['iife'], fileName: () => basename(destination) }, outDir: dirname(destination), emptyOutDir: false,
  target: 'chrome140', minify: 'esbuild' } });
