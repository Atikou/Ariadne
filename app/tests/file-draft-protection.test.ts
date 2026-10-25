import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileDraftProtection } from '../src/renderer/src/core/runtime/features/file-draft-protection';
import type { FileDraftCatalog, FileDraftRecord, FileDraftReplace } from '../src/shared/file-drafts';

const adapters: FileDraftProtection[] = [];
function row(): FileDraftRecord { return { draftId: crypto.randomUUID(), workspaceId: 'workspace-a', path: 'notes.txt', revision: 1,
  updatedAt: new Date().toISOString(), content: 'A', originalContent: 'old', version: `workspace-file-v1:${'a'.repeat(64)}`,
  writable: true, exists: true, pendingMutation: null }; }
function fixture(initial: FileDraftRecord[] = []) {
  let catalog: FileDraftCatalog = { revision: 0, records: structuredClone(initial) }, current = structuredClone(initial);
  const publish = vi.fn();
  const api = { list: vi.fn(async () => structuredClone(catalog)), replace: vi.fn(async (request: FileDraftReplace) => {
    if (request.expectedRevision !== catalog.revision) throw new Error('fixture_cas');
    catalog = structuredClone({ revision: catalog.revision + 1, records: request.records }); return structuredClone(catalog);
  }) };
  const adapter = new FileDraftProtection(api, () => current, publish); adapters.push(adapter);
  return { adapter, api, publish, set: (rows: FileDraftRecord[]) => { current = rows; }, current: () => current };
}
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); });
describe('private file protection acknowledgement', () => {
  it('restores all owned entries before publishing ready and coalesces concurrent initialization', async () => {
    const a = row(), f = fixture([a]); let restored = false;
    f.publish.mockImplementation(() => { expect(restored).toBe(true); expect(f.adapter.getState().ready).toBe(true); });
    const first = f.adapter.initialize(records => { expect(records).toEqual([a]); restored = true; });
    const second = f.adapter.initialize(() => { throw new Error('duplicate restore'); });
    expect(first).toBe(second); await first; expect(f.api.list).toHaveBeenCalledTimes(1);
    expect(f.adapter.protectedRevision(a.draftId)).toBe(1); expect(f.api.replace).not.toHaveBeenCalled();
  });
  it('a late A protection acknowledgement cannot claim the newer B revision is protected', async () => {
    const f = fixture(); await f.adapter.initialize(() => undefined); const a = row(); f.set([a]); f.adapter.changed();
    const normal = f.api.replace.getMockImplementation()!; let release!: () => void;
    f.api.replace.mockImplementationOnce(async request => { await new Promise<void>(resolve => { release = resolve; }); return normal(request); });
    const first = f.adapter.flush(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const b = { ...a, content: 'B', revision: 2 }; f.set([b]); f.adapter.changed(); release(); await first;
    expect(f.current()).toEqual([b]); expect(f.adapter.protectedRevision(a.draftId)).toBe(1);
    await f.adapter.flush(); expect(f.adapter.protectedRevision(a.draftId)).toBe(2);
    expect(f.api.replace.mock.calls[1]![0]).toMatchObject({ expectedRevision: 1, records: [b] });
  });
  it('keeps local content and latches failed protection without silently retrying an unknown storage result', async () => {
    const f = fixture(); await f.adapter.initialize(() => undefined); const a = row(); f.set([a]); f.adapter.changed();
    f.api.replace.mockRejectedValueOnce(new Error('disk fixture unavailable'));
    await expect(f.adapter.flushAndClose()).rejects.toThrow('disk fixture unavailable');
    expect(f.current()).toEqual([a]); expect(f.adapter.getState().error).toBe('文件草稿存储不可用，请复制当前修改并保留窗口。');
    expect(f.adapter.protectedRevision(a.draftId)).toBeNull();
    f.adapter.changed(); await expect(f.adapter.flush()).rejects.toThrow('文件草稿存储不可用');
    expect(f.api.replace).toHaveBeenCalledTimes(1);
  });
  it('closes only after persistence and resumes editing when quit is cancelled', async () => {
    const f = fixture(); await f.adapter.initialize(() => undefined); const a = row(); f.set([a]); f.adapter.changed();
    await f.adapter.flushAndClose(); expect(f.adapter.protectedRevision(a.draftId)).toBe(1);
    expect(() => f.adapter.changed()).toThrow('closed'); f.adapter.resumeAfterCancelledQuit();
    f.set([{ ...a, content: 'B', revision: 2 }]); f.adapter.changed(); await f.adapter.flush();
    expect(f.adapter.protectedRevision(a.draftId)).toBe(2);
  });
  it('an unreadable optional store does not overwrite its source or block an untouched file editor from quitting',async()=>{
    const f=fixture();f.api.list.mockRejectedValueOnce(new Error('unreadable fixture source'));
    await f.adapter.initialize(()=>undefined);expect(f.adapter.getState().error).toBe('文件草稿存储不可用，请复制当前修改并保留窗口。');
    await f.adapter.flushAndClose();expect(f.api.replace).not.toHaveBeenCalled();
  });
});
