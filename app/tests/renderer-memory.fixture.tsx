// Explicit deferred UI fixtures; no production database or model is accessed.
import type { LongMemoryRecord } from '@ariadne/protocol/public';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { moduleId } from '../src/renderer/src/core/modules/module-contract';
import { MemoryPanel } from '../src/renderer/src/modules/memory/MemoryPanel';

function source<T>(initial: T) {
  let snapshot = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: T) => { snapshot = next; listeners.forEach(listener => listener()); } };
}
const sessions = source({ selectedSessionId: 'memory-a', sessions: [{ sessionId: 'memory-a', workspaceId: 'workspace-a' }, { sessionId: 'memory-b', workspaceId: 'workspace-b' }] });
const date = '2026-10-04T00:00:00Z';
const make = (id: string, status: LongMemoryRecord['status']): LongMemoryRecord => ({ memoryId: id, version: 1, scope: 'workspace', scopeId: 'workspace-a',
  memoryType: 'fact', title: `【UI 夹具】${id}`, content: '【UI 夹具】不是实际记忆 ' + 'LongContent'.repeat(100), status, importance: 0.8,
  confidence: 1, sensitivity: 'workspace', retentionUntil: null, provenance: status === 'candidate' ? { kind: 'agent', runId: 'fixture-run' } : { kind: 'user' },
  reviewedAt: status === 'candidate' ? null : date, createdAt: date, updatedAt: date, expired: false });
let records = [make('candidate', 'candidate'), make('active', 'active')];
const queries: Array<{ owner: { sessionId: string }; before: unknown; resolve(value: unknown): void; reject(error: Error): void }> = [];
const operations: Array<{ kind: string; args: unknown[]; resolve(): void; reject(error: Error): void }> = [];
const recalls: Array<{ resolve(value: unknown): void }> = [];
function operation(kind: string, args: unknown[]) { return new Promise<void>((resolve, reject) => operations.push({ kind, args, resolve, reject })); }
const services = { sessions: { view: sessions }, memory: {
  query: (owner: { sessionId: string }, _status: string, before: unknown) => new Promise((resolve, reject) => queries.push({ owner, before, resolve, reject })),
  read: async (_owner: unknown, memoryId: string) => records.find(record => record.memoryId === memoryId) ?? null,
  transition: (...args: unknown[]) => operation('transition', args), put: (...args: unknown[]) => operation('put', args), forget: (...args: unknown[]) => operation('forget', args),
  recall: () => new Promise(resolve => recalls.push({ resolve }))
} } as unknown as ModuleServices;
Object.assign(window, { __memoryFixture: {
  resetEditingScenario: () => { records = [make('edit-current', 'active')]; sessions.update({ ...sessions.getSnapshot(), selectedSessionId: 'memory-a' }); },
  updateCurrent: (version: number, remove = false) => { records = remove ? [] : [{ ...records[0]!, version, title: `【UI 夹具】后台标题 v${version}`, content: `【UI 夹具】后台正文 v${version}` }]; },
  queryCount: () => queries.length, operationCount: () => operations.length, recallCount: () => recalls.length,
  operations: () => operations.map(({ kind, args }) => ({ kind, args })),
  resolvePage: (index: number, more = false, empty = false) => queries[index]!.resolve({ kind: 'memory.query_result', memories: empty ? [] : records,
    nextCursor: more ? { updatedAt: date, memoryId: records.at(-1)!.memoryId } : null }),
  rejectPage: (index: number) => queries[index]!.reject(new Error('STALE MEMORY PAGE FAILURE')),
  rejectOperation: (index: number) => operations[index]!.reject(new Error('【UI 夹具】版本冲突，请刷新')),
  resolveOperation: (index: number) => {
    const op = operations[index]!;
    if (op.kind === 'transition') {
      const memory = op.args[1] as LongMemoryRecord;
      records = records.map(record => record.memoryId === memory.memoryId ? { ...record, version: record.version + 1,
        status: op.args[2] === 'activate' ? 'active' : 'inactive', reviewedAt: date } : record);
    }
    if (op.kind === 'forget') records = records.filter(record => record.memoryId !== (op.args[1] as LongMemoryRecord).memoryId);
    if (op.kind === 'put') { const id = op.args[1] as string, version = op.args[2] as number;
      records = records.map(record => record.memoryId === id ? { ...record, ...(op.args[3] as object), version: version + 1 } : record); }
    op.resolve();
  },
  resolveRecall: (index: number, stale = false) => recalls[index]!.resolve({ kind: 'memory.recall_result', complete: true,
    hits: [{ memory: stale ? { ...make('stale', 'active'), title: 'STALE MEMORY RECALL' } : records[0]!, score: 0.8, reason: 'lexical' }],
    embedding: { provider: 'lexical', capability: 'lexical_approximation', dimension: 256, modelId: null, degraded: true, reason: 'lexical_approximation_not_semantic' } }),
  resolveLimitedRecall: (index:number,reason:'model_unavailable'|'index_rebuild_required'|null) => recalls[index]!.resolve({kind:'memory.recall_result',complete:false,hits:[],
    embedding:{provider:'local-gguf',capability:'semantic',dimension:768,modelId:'【UI 夹具】受限模型',degraded:true,reason}}),
  switchSession: () => sessions.update({ ...sessions.getSnapshot(), selectedSessionId: 'memory-b' })
} });
export function MemoryPageFixture({ page }: { page: string }): React.JSX.Element | null {
  return page === 'memory' ? <MemoryPanel moduleId={moduleId('memory.manage')} services={services} /> : null;
}
