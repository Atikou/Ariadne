import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/** Cross-workspace production integration belongs to the composition root. */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('app/src/shared'), '@renderer': resolve('app/src/renderer/src') } },
  test: { environment: 'node', include: ['tests/integration/**/*.test.ts'], maxWorkers: 2 }
});
