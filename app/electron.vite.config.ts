import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const aliases = {
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src')
};

export default defineConfig({
  main: {
    resolve: { alias: aliases }
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
