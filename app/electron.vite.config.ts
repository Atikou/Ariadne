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
