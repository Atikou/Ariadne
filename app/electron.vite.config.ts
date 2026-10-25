import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { build as buildVite } from 'vite';

const aliases = {
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src')
};

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    plugins: [{ name: 'ariadne-data-root-switch-helper', async closeBundle() {
      // Ordinary Node cannot read Electron's ASAR or import Electron Main.
      // Emit one self-contained CJS helper with only node:* dependencies.
      await buildVite({ configFile: false, build: { target: 'node22', minify: false,
        emptyOutDir: false, outDir: resolve('out/main'),
        lib: { entry: resolve('src/main/runtime/data-root-switch-process.ts'), formats: ['cjs'],
          fileName: () => 'data-root-switch-process.cjs' },
        rollupOptions: { external: id => id.startsWith('node:') } } });
    } }]
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      // A sandboxed preload can require Electron and the small built-in Node
      // surface only. Bundle every application dependency so the emitted CJS
      // never tries to load workspace packages or Zod inside the sandbox.
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    resolve: { alias: aliases },
    plugins: [react()]
  }
});
