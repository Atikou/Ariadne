import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_STARTUP_STAGES } from '../../runtime/dist/composition/RuntimeStartupTrace.js';

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../artifacts/todo-remediation');
const sourceName = process.argv[2]; const reportName = process.argv[3];
assert(/^[a-z0-9][a-z0-9_-]*$/u.test(sourceName ?? ''), 'Evidence folder must be a basename.');
assert(/^[a-z0-9][a-z0-9_-]*\.json$/u.test(reportName ?? ''), 'Report must be a JSON basename.');
const read = (...parts) => JSON.parse(readFileSync(join(evidenceRoot, sourceName, ...parts), 'utf8').replace(/^\uFEFF/u, ''));
const phases = ['baseline', 'initial', 'main-restart'].map(phase => {
  const result = read(phase, `capacity-${phase}.json`);
  const startup = read(phase, 'runtime-startup-metrics.json');
  const processes = read(phase, 'runtime-process-metrics.json');
  assert(result.passed && !result.unexpectedRuntimeCrash && startup.format === 'ariadne-capacity-startup-metrics.v1');
  assert(startup.traces.length === (phase === 'initial' ? 2 : 1));
  return { phase, uiStartupMs: result.startupMs, unexpectedRuntimeCrash: result.unexpectedRuntimeCrash,
    traces: startup.traces.map(trace => {
      assert(trace.completed && trace.points.length <= 128 && trace.points[0].stage === 'bootstrap');
      const intervals = []; const points = trace.points;
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        assert(point.pid === trace.pid && RUNTIME_STARTUP_STAGES.includes(point.stage));
        assert(Object.values(point.memory).every(value => Number.isFinite(value) && value >= 0));
        if (index > 0) {
          const previous = points[index - 1]; assert(point.elapsedMs >= previous.elapsedMs);
          intervals.push({ stage: previous.stage, until: point.stage, durationMs: point.elapsedMs - previous.elapsedMs,
            heapUsedDeltaBytes: point.memory.heapUsed - previous.memory.heapUsed,
            rssDeltaBytes: point.memory.rss - previous.memory.rss });
        }
      }
      assert(points.at(-1).stage === 'ready');
      const samples = processes.samples.filter(sample => sample.pid === trace.pid);
      assert(samples.length > 0);
      return { pid: trace.pid, processReadyMs: points.at(-1).processElapsedMs,
        tracedStartupMs: points.at(-1).elapsedMs - points[0].elapsedMs,
        pointPeakHeapUsedBytes: Math.max(...points.map(point => point.memory.heapUsed)),
        runtimeSampleCount: samples.length,
        runtimeSamplePeakRssBytes: Math.max(...samples.map(sample => sample.workingSetBytes)),
        intervals };
    }) };
});
const report = { format: 'ariadne-runtime-startup-attribution.v1', source: sourceName,
  notes: ['Stage points are interval boundaries, not continuous heap peaks.',
    'Runtime process RSS samples and Renderer heap are separate measurements.',
    'No forced GC, timeout increase, replay skip or integrity bypass.'], phases };
writeFileSync(join(evidenceRoot, reportName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(phases.map(phase => ({ phase: phase.phase, uiStartupMs: phase.uiStartupMs,
  traces: phase.traces.map(trace => ({ processReadyMs: trace.processReadyMs,
    pointPeakHeapUsedBytes: trace.pointPeakHeapUsedBytes, runtimeSamplePeakRssBytes: trace.runtimeSamplePeakRssBytes,
    longestIntervals: [...trace.intervals].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3) })) })), null, 2));
