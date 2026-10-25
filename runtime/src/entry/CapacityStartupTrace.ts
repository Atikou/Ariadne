import { closeSync, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RUNTIME_STARTUP_STAGES, type RuntimeStartupStage, type RuntimeStartupTrace } from '../composition/RuntimeStartupTrace.js';

/** Explicit capacity gate only; normal Runtime startup has no trace sink. */
export function createCapacityStartupTrace(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeStartupTrace | undefined {
  if (environment.ARIADNE_SMOKE_TEST !== '1' || environment.ARIADNE_SMOKE_PROJECTION_CAPACITY !== '1') return undefined;
  const userData = environment.ARIADNE_SMOKE_USER_DATA;
  const output = environment.ARIADNE_SMOKE_TEST_OUTPUT;
  if (!userData || !output || !isAbsolute(userData) || !isAbsolute(output)) throw new Error('capacity_startup_trace_paths_invalid');
  // Native resolution compares physical directories, including Windows short paths.
  const root = realpathSync.native(userData);
  const temporary = realpathSync.native(tmpdir());
  const withinTemporary = relative(temporary, root);
  if (!withinTemporary || withinTemporary.startsWith('..' + sep) || isAbsolute(withinTemporary)
    || dirname(root).toLowerCase() !== temporary.toLowerCase() || !basename(root).startsWith('AriadneCapacity-')) {
    throw new Error('capacity_startup_trace_requires_isolated_fixture');
  }
  const expectedDataRoot = join(root, 'runtime');
  const destination = realpathSync.native(output);
  let descriptor: number | undefined;
  let points = 0;
  const startedAt = performance.now();
  return {
    bind(dataRoot): void {
      if (realpathSync.native(dataRoot).toLowerCase() !== expectedDataRoot.toLowerCase()) throw new Error('capacity_startup_trace_data_root_mismatch');
      if (descriptor !== undefined) throw new Error('capacity_startup_trace_already_bound');
      descriptor = openSync(join(destination, `runtime-startup-${process.pid}.jsonl`), 'wx');
    },
    point(stage): void {
      if (descriptor === undefined) return;
      if (!RUNTIME_STARTUP_STAGES.includes(stage) || ++points > 128) throw new Error('capacity_startup_trace_stage_invalid');
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      writeSync(descriptor, JSON.stringify({ format: 'ariadne-runtime-startup-point.v2', pid: process.pid,
        stage: stage as RuntimeStartupStage, elapsedMs: performance.now() - startedAt,
        processElapsedMs: process.uptime() * 1_000,
        wallTimeMs: Date.now(), cpu: { userMicros: cpu.user, systemMicros: cpu.system },
        memory: { rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed,
          external: memory.external, arrayBuffers: memory.arrayBuffers } }) + '\n');
      if (stage === 'ready' || stage === 'failed') { closeSync(descriptor); descriptor = undefined; }
    }
  };
}
