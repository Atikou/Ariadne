import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapacityStartupTrace } from '../src/entry/CapacityStartupTrace.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const withinTemporary = relative(tmpdir(), root);
    if (!withinTemporary.startsWith('AriadneCapacity-') || withinTemporary.includes(sep) || isAbsolute(withinTemporary)) throw new Error('unsafe_test_cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'AriadneCapacity-')); roots.push(root);
  const dataRoot = join(root, 'runtime'); const output = join(root, 'evidence');
  mkdirSync(dataRoot); mkdirSync(output);
  return { root, dataRoot, output, environment: {
    ARIADNE_SMOKE_TEST: '1', ARIADNE_SMOKE_PROJECTION_CAPACITY: '1',
    ARIADNE_SMOKE_USER_DATA: root, ARIADNE_SMOKE_TEST_OUTPUT: output
  } };
}

describe('capacity startup attribution', () => {
  it('does not create a sink in normal or unrelated smoke startup', () => {
    expect(createCapacityStartupTrace({})).toBeUndefined();
    expect(createCapacityStartupTrace({ ARIADNE_SMOKE_TEST: '1' })).toBeUndefined();
    expect(createCapacityStartupTrace({ ARIADNE_SMOKE_PROJECTION_CAPACITY: '1' })).toBeUndefined();
  });
  it('writes only fixed stage and numeric resource metadata, then closes at ready', () => {
    const f = fixture(); const trace = createCapacityStartupTrace({
      ...f.environment, ARIADNE_SMOKE_USER_DATA: realpathSync.native(f.root)
    })!;
    trace.bind(f.dataRoot); trace.point('bootstrap'); trace.point('public_projection_store_open'); trace.point('ready'); trace.point('failed');
    const files = readdirSync(f.output); expect(files).toHaveLength(1);
    const points = readFileSync(join(f.output, files[0]!), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(points.map(p => p.stage)).toEqual(['bootstrap', 'public_projection_store_open', 'ready']);
    for (const point of points) {
      expect(Object.keys(point).sort()).toEqual(['cpu', 'elapsedMs', 'format', 'memory', 'pid', 'processElapsedMs', 'stage', 'wallTimeMs']);
      expect(point.format).toBe('ariadne-runtime-startup-point.v2');
      expect(Object.keys(point.cpu).sort()).toEqual(['systemMicros', 'userMicros']);
      expect(Object.values(point.cpu).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)).toBe(true);
      expect(point.wallTimeMs).toBeGreaterThan(0);
      expect(Object.keys(point.memory).sort()).toEqual(['arrayBuffers', 'external', 'heapTotal', 'heapUsed', 'rss']);
      expect(Object.values(point.memory).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)).toBe(true);
      expect(point.pid).toBe(process.pid);
    }
    expect(points[2].elapsedMs).toBeGreaterThanOrEqual(points[0].elapsedMs);
    expect(points[2].wallTimeMs).toBeGreaterThanOrEqual(points[0].wallTimeMs);
    expect(points[2].cpu.userMicros + points[2].cpu.systemMicros).toBeGreaterThanOrEqual(points[0].cpu.userMicros + points[0].cpu.systemMicros);
    expect(JSON.stringify(points)).not.toContain(f.root);
  });
  it('rejects a different authority directory without opening evidence and keeps failed stage evidence', () => {
    const f = fixture(); const other = fixture(); const trace = createCapacityStartupTrace(f.environment)!;
    expect(() => trace.bind(other.dataRoot)).toThrow('capacity_startup_trace_data_root_mismatch');
    expect(readdirSync(f.output)).toEqual([]);
    trace.bind(f.dataRoot); trace.point('bootstrap'); trace.point('failed');
    const data = readFileSync(join(f.output, readdirSync(f.output)[0]!), 'utf8');
    expect(data.trim().split('\n')).toHaveLength(2);
    expect(data).toContain('"stage":"failed"');
  });
  it('rejects a fixture outside the direct named TEMP scope', () => {
    const f = fixture();
    expect(() => createCapacityStartupTrace({ ...f.environment, ARIADNE_SMOKE_USER_DATA: f.dataRoot })).toThrow('capacity_startup_trace_requires_isolated_fixture');
  });
});
