import { describe, expect, it, vi } from 'vitest';
import {
  LocalLiveWorkRegistry,
  type LiveWorkOutcome,
  type LiveWorkOwner
} from '../src/index.js';

const owner: LiveWorkOwner = {
  authority: 'agent-run',
  ownerId: 'run-1',
  workspaceId: 'workspace-1'
};

describe('LocalLiveWorkRegistry', () => {
  it('owns identity, exact-owner authorization and atomic idempotent start', () => {
    const harness = createHarness();
    const registry = createRegistry();
    const first = registry.start({
      kind: 'process',
      label: 'node repl.js',
      owner,
      dedupeKey: 'effect-1',
      start: harness.start
    });
    const duplicate = registry.start({
      kind: 'process',
      label: 'ignored',
      owner,
      dedupeKey: 'effect-1',
      start: () => { throw new Error('must_not_start'); }
    });

    expect(duplicate.id).toBe(first.id);
    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(() => registry.get({ ...owner, ownerId: 'run-foreign' }, first.id))
      .toThrow('live_work_not_found');
    expect(registry.list({ ...owner, workspaceId: 'workspace-foreign' })).toEqual([]);
  });

  it('keeps byte cursors while never returning broken UTF-8', () => {
    const harness = createHarness();
    const registry = createRegistry();
    const work = registry.start({ kind: 'process', label: 'unicode', owner, start: harness.start });
    harness.append!('stdout', 'A你🙂Z');

    const first = registry.read(owner, work.id, 0, 3);
    expect(first.chunks.map((chunk) => chunk.text).join('')).toBe('A');
    expect(first.nextCursor).toBe(1);
    const second = registry.read(owner, work.id, first.nextCursor, 7);
    expect(second.chunks.map((chunk) => chunk.text).join('')).toBe('你🙂');
    expect(second.nextCursor).toBe(8);
    expect(registry.read(owner, work.id, 2, 64).chunks.map((chunk) => chunk.text).join(''))
      .toBe('🙂Z');
  });

  it('commits completion before listeners run and settles only once', async () => {
    const harness = createHarness();
    const registry = createRegistry();
    const done = vi.fn((event) => {
      expect(registry.get(owner, event.snapshot.id).status).toBe('completed');
    });
    registry.onDone(done);
    const work = registry.start({ kind: 'process', label: 'short', owner, start: harness.start });
    harness.complete({ status: 'completed', exitCode: 0 });
    await expect(registry.wait(owner, work.id, 100)).resolves.toMatchObject({
      completed: true,
      snapshot: { status: 'completed', reported: true }
    });
    harness.complete({ status: 'failed', detail: 'late' });
    expect(done).toHaveBeenCalledTimes(1);
    expect(registry.get(owner, work.id)).toMatchObject({ status: 'completed', exitCode: 0 });
  });

  it('serializes input and cancels every owned producer during shutdown', async () => {
    const first = createHarness();
    const second = createHarness();
    const registry = createRegistry();
    registry.start({ kind: 'terminal', label: 'one', owner, start: first.start });
    registry.start({ kind: 'process', label: 'two', owner, start: second.start });
    const closing = registry.closeOwner(owner, 100);
    expect(first.cancel).toHaveBeenCalledWith('owner_closed');
    expect(second.cancel).toHaveBeenCalledWith('owner_closed');
    first.complete({ status: 'killed' });
    second.complete({ status: 'killed' });
    await expect(closing).resolves.toBeUndefined();
  });

  it('does not publish a record when producer preflight throws', () => {
    const registry = createRegistry();
    expect(() => registry.start({
      kind: 'process',
      label: 'bad',
      owner,
      start: () => { throw new Error('spawn_failed'); }
    })).toThrow('spawn_failed');
    expect(registry.list(owner)).toEqual([]);
  });
});

function createRegistry(): LocalLiveWorkRegistry {
  let nextId = 0;
  return new LocalLiveWorkRegistry({ createId: () => `work-${++nextId}` });
}

function createHarness() {
  let resolveDone!: (outcome: LiveWorkOutcome) => void;
  const done = new Promise<LiveWorkOutcome>((resolve) => { resolveDone = resolve; });
  const cancel = vi.fn();
  const write = vi.fn(async () => undefined);
  const harness: {
    append?: (channel: 'stdout' | 'stderr', text: string) => void;
    start: ReturnType<typeof vi.fn>;
    cancel: typeof cancel;
    complete(outcome: LiveWorkOutcome): void;
  } = {
    start: vi.fn((context) => {
      harness.append = context.appendOutput;
      return { done, cancel, write };
    }),
    cancel,
    complete: resolveDone
  };
  return harness;
}
