import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeResultSchema, type LongMemoryContent } from '@ariadne/protocol/public';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import { LocalGgufEmbeddingProvider, LocalLexicalEmbeddingProvider, type EmbeddingProvider } from '../src/adapters/embedding/LocalMemoryEmbedding.js';
import { SqliteLongMemoryStore } from '../src/adapters/persistence/SqliteLongMemoryStore.js';
import { ProductionLongMemoryService, createProductionLongMemoryService } from '../src/composition/ProductionLongMemoryService.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { MEMORY_INDEX_RELATIVE_PATH, type SqliteLongMemoryIndexStore } from '../src/adapters/persistence/SqliteLongMemoryIndexStore.js';

const scope = { workspaceId: 'workspace-a', sessionId: 'session-a' };
const now = new Date('2026-10-04T00:00:00Z');
const signal = () => new AbortController().signal;
const content: LongMemoryContent = { scope: 'workspace', memoryType: 'fact', title: 'Storage decision', content: 'SQLite persistence',
  importance: 0.8, confidence: 1, sensitivity: 'workspace', retentionUntil: null };
const put = (id = 'memory-a', fields: Partial<LongMemoryContent> = {}) => ({ kind: 'memory.put', contractVersion: '5.0',
  ...scope, ...content, ...fields, memoryId: id, expectedVersion: null } as const);
const roots: string[] = []; const owners: { service: ProductionLongMemoryService; store: SqliteLongMemoryStore }[] = [];
function root() { const value = mkdtempSync(path.join(tmpdir(), 'ariadne-memory-service-')); roots.push(value); return value; }
function lexical(directory = root(), clock = () => now) {
  const store = new SqliteLongMemoryStore(directory); const opening = vi.spyOn(store, 'openSearchIndex'); const service = new ProductionLongMemoryService(store,
    new LocalLexicalEmbeddingProvider(), { provider: 'lexical' }, clock);
  owners.push({ store, service }); return { store, service, directory, index: opening.mock.results[0]!.value as SqliteLongMemoryIndexStore };
}
function neural(embed: (text: string) => Promise<number[]>, directory = root(), identity = 'fixture-a', dimension = 2) {
  // A deterministic adapter fixture exercises ownership and cache semantics, not real neural quality.
  const modelPath = path.join(directory, identity + '.gguf'); const bytes = Buffer.from(identity); writeFileSync(modelPath, bytes);
  const policy: RuntimePolicySnapshot['embedding'] = { provider: 'local-gguf', modelId: identity, modelPath,
    sha256: createHash('sha256').update(bytes).digest('hex'), dimension, gpuLayers: 0 };
  const embedding = new LocalGgufEmbeddingProvider({ ...policy, runtimeFactory: async () => ({ dimension, embed, async dispose() {} }) });
  const store = new SqliteLongMemoryStore(directory); const opening = vi.spyOn(store, 'openSearchIndex'); const service = new ProductionLongMemoryService(store, embedding, policy, () => now);
  owners.push({ store, service }); return { store, service, directory, embedding, index: opening.mock.results[0]!.value as SqliteLongMemoryIndexStore };
}
async function waitIndexed(fixture: {store:SqliteLongMemoryStore;index:SqliteLongMemoryIndexStore;service:ProductionLongMemoryService}) {
  await expect.poll(async () => {
    const state = fixture.index.state(); if (!state || state.scanning) return false;
    const changes = await fixture.store.indexChanges(state.cursor, 1);
    if (changes.resetRequired || changes.changes.length || !fixture.index.vectorCandidates(state.spaceId, scope,
      Array.from({length:state.dimension}, () => 0), 128, now.getTime()).complete) return false;
    return (await fixture.service.recall(scope,'readiness probe',20,signal())).complete;
  }, {timeout:4000,interval:10}).toBe(true);
}
async function close(service: ProductionLongMemoryService) {
  const shutdown = createShutdownContext(Date.now() + 5_000); try { await service.close(shutdown); } finally { shutdown.dispose(); }
}
afterEach(async () => {
  for (const { service } of owners.splice(0)) await close(service);
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('production long-memory recall and lifecycle', () => {
  it('reports lexical approximation honestly and excludes foreign, expired, inactive and candidate data', async () => {
    const fixture = lexical(); const { service } = fixture;
    await service.execute('active', put(), signal());
    await service.execute('expired', put('expired', { retentionUntil: now.toISOString() }), signal());
    await service.stageCandidate('candidate', { ...scope, ...content, memoryId: 'candidate', runId: 'run-a' }, signal());
    await service.execute('inactive', put('inactive'), signal());
    await service.execute('deactivate', { kind: 'memory.transition', contractVersion: '5.0', ...scope,
      memoryId: 'inactive', expectedVersion: 1, action: 'deactivate' }, signal());
    expect(await service.recall(scope, 'SQLite', 20, signal())).toMatchObject({complete:false});
    await waitIndexed(fixture); const result = await service.recall(scope, 'SQLite', 20, signal());
    expect(result.hits.map(hit => hit.memory.memoryId)).toEqual(['memory-a']);
    expect(result).toMatchObject({ complete: true, embedding: { capability: 'lexical_approximation', degraded: true,
      reason: 'lexical_approximation_not_semantic' } });
    expect(result.hits.every(hit => hit.reason === 'lexical')).toBe(true);
    expect(runtimeResultSchema.parse(result)).toEqual(result);
    expect((await service.recall({ workspaceId: 'other', sessionId: 'other' }, 'SQLite', 20, signal())).hits).toEqual([]);
  });

  it('persists exact versioned vectors across reopening and rebuilds when the pinned embedding space changes', async () => {
    const calls: string[] = []; const embed = async (text: string) => { calls.push(text); return [1, 0]; };
    const first = neural(embed); await first.service.execute('create', put(), signal());
    const cold = await first.service.recall(scope, 'different words', 20, signal());
    expect(cold).toMatchObject({complete:false,hits:[],embedding:{reason:'index_rebuild_required'}}); expect(calls).toHaveLength(0);
    await waitIndexed(first);
    const result = await first.service.recall(scope, 'different words', 20, signal());
    expect(result.hits[0]).toMatchObject({ reason: 'semantic', memory: { version: 1 } }); expect(calls.filter(text=>text.includes('Storage decision'))).toHaveLength(1);
    await close(first.service);
    const reopened = neural(embed, first.directory); await waitIndexed(reopened); await reopened.service.recall(scope, 'different words', 20, signal());
    expect(calls.filter(text=>text.includes('Storage decision'))).toHaveLength(1); await close(reopened.service);
    const changed = neural(embed, first.directory, 'fixture-b'); await waitIndexed(changed); await changed.service.recall(scope, 'different words', 20, signal());
    expect(calls.filter(text=>text.includes('Storage decision'))).toHaveLength(2);
  });

  it('does not return or cache a deleted record when a model request finishes after deletion', async () => {
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let release!: (vector: number[]) => void; const pending = new Promise<number[]>(resolve => { release = resolve; });
    const fixture = neural(async text => { if (text.includes('Storage decision')) { entered(); return pending; } return [1, 0]; }); const {service,store}=fixture;
    await service.execute('create', put(), signal());
    await enteredPromise;
    await service.execute('delete', { kind: 'memory.delete', contractVersion: '5.0', ...scope, memoryId: 'memory-a', expectedVersion: 1 }, signal());
    expect((await service.recall(scope, 'SQLite', 20, signal())).hits).toEqual([]);
    release([1, 0]); await waitIndexed(fixture); expect((await service.recall(scope, 'SQLite', 20, signal())).hits).toEqual([]); expect(await store.get('memory-a', scope, now)).toBeNull();
  });

  it('returns only actual lexical evidence when the model fails, then clears degradation after recovery', async () => {
    let fail = true; const fixture = neural(async () => { if (fail) throw new Error('private model failure'); return [1, 0]; }); const {service}=fixture;
    await service.execute('create', put(), signal()); await expect.poll(() => service.hasExternalFailure()).toBe(true);
    const degraded = await service.recall(scope, 'SQLite', 20, signal());
    expect(degraded).toMatchObject({ complete: false, embedding: { degraded: true, reason: 'model_unavailable' } });
    expect(degraded.hits[0]!.reason).toBe('lexical'); expect(JSON.stringify(degraded)).not.toContain('private model failure');
    expect(service.hasExternalFailure()).toBe(true); expect(() => service.assertHealthy()).not.toThrow();
    fail = false; await waitIndexed(fixture); expect(await service.recall(scope, 'SQLite', 20, signal())).toMatchObject({ complete: true, embedding: { degraded: false, reason: null } });
    expect(service.hasExternalFailure()).toBe(false);
  });

  it('rebuilds corrupt derived vectors while preserving source authority and actual lexical evidence', async () => {
    const fixture = neural(async () => [1, 0]); const {service,directory,store}=fixture;
    await service.execute('create', put(), signal()); await waitIndexed(fixture);
    const database = new DatabaseSync(path.join(directory,MEMORY_INDEX_RELATIVE_PATH));
    try { database.prepare('UPDATE memory_index_vectors SET vector_json=?').run('[null,null]'); } finally {database.close();}
    expect(await service.recall(scope, 'SQLite', 20, signal())).toMatchObject({complete:false,embedding:{reason:'index_rebuild_required'},hits:[{reason:'lexical'}]});
    expect(() => store.assertHealthy()).not.toThrow(); expect((await store.get('memory-a',scope,now))?.content).toBe(content.content);
    await waitIndexed(fixture); expect(await service.recall(scope,'different words',20,signal())).toMatchObject({complete:true,hits:[{reason:'semantic'}]});
  });
  it('retains external failure when only query embedding recovers but a document embedding still fails', async () => {
    let mode: 'all' | 'document' | 'none' = 'all';
    const fixture = neural(async text => {
      if (mode === 'all' || (mode === 'document' && text.includes('Storage decision'))) throw new Error('private embedding error');
      return [1, 0];
    });
    const {service}=fixture;
    await service.execute('create', put(), signal()); await expect.poll(() => service.hasExternalFailure()).toBe(true);
    mode = 'document'; expect(await service.recall(scope, 'SQLite', 20, signal())).toMatchObject({ complete: false, embedding: { reason: 'model_unavailable' } });
    expect(service.hasExternalFailure()).toBe(true); mode = 'none'; await waitIndexed(fixture);
    expect(await service.recall(scope, 'SQLite', 20, signal())).toMatchObject({ complete: true, embedding: { reason: null, degraded: false } });
    expect(service.hasExternalFailure()).toBe(false);
  });

  it('selects bounded reviewed instruction context and leaves complete content available for recall', async () => {
    const fixture = lexical(); const {service}=fixture;
    for (let index = 0; index < 10; index++) await service.execute('create-' + index, put('memory-' + index, {
      content: 'SQLite ' + '字'.repeat(2_000), importance: index / 10, memoryType: 'preference' }), signal());
    await service.stageCandidate('candidate', { ...scope, ...content, memoryId: 'candidate', runId: 'run-a' }, signal());
    await waitIndexed(fixture); const records = await service.instructionMemories(scope, signal()); expect(records).toHaveLength(8);
    expect(records[0]!.memoryId).toBe('memory-9'); expect(records.every(record => record.status === 'active' && record.reviewedAt !== null)).toBe(true);
    expect(records[0]!.content).toContain('【记忆已截断');
    expect((await service.recall(scope, 'SQLite', 20, signal())).hits[0]!.memory.content.length).toBe(2_007);
  });

  it('joins an in-flight native operation before releasing the database owner and denies new work while stopping', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (vector: number[]) => void; const pending = new Promise<number[]>(resolve => { release = resolve; });
    const fixture = neural(async text => { if (text==='query') { entered(); return pending; } return [1,0]; }); const { service, directory }=fixture;
    await waitIndexed(fixture);
    const recall = service.recall(scope, 'query', 20, signal()); const rejected = expect(recall).rejects.toThrow('long_memory_stopping');
    await started; const closing = close(service); let closed = false; void closing.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    expect(() => new SqliteLongMemoryStore(directory)).toThrow('sqlite_owner_lease_unavailable');
    await expect(service.execute('new', put(), signal())).rejects.toThrow('long_memory_stopping');
    release([1, 0]); await rejected; await closing;
    const reopened = lexical(directory); expect(await reopened.store.get('memory-a', scope, now)).toBeNull();
  });

  it('rejects invalid embedding policy before acquiring the database owner', () => {
    const directory = root();
    expect(() => createProductionLongMemoryService(directory, { provider: 'local-gguf', modelId: 'invalid', modelPath: path.join(directory, 'missing'),
      sha256: '0'.repeat(64), dimension: 0, gpuLayers: 0 })).toThrow('long_memory_embedding_contract_invalid');
    expect(() => lexical(directory)).not.toThrow();
  });

  it('cancels foreground waiting promptly without freeing a still-running native capacity', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:(vector:number[])=>void;const pending=new Promise<number[]>(resolve=>{release=resolve;});
    const calls:string[]=[];
    const fixture=neural(async text=>{calls.push(text);if(text==='blocked query'){entered();return pending;}return [1,0];});
    await waitIndexed(fixture);const controller=new AbortController();
    const query=fixture.service.recall(scope,'blocked query',20,controller.signal);
    const rejected=expect(query).rejects.toThrow('user_cancelled');await started;controller.abort(new Error('user_cancelled'));await rejected;
    expect(await fixture.service.recall(scope,'second query',20,signal())).toMatchObject({complete:false,embedding:{degraded:true,reason:null}});
    expect(calls).not.toContain('second query');
    const closing=close(fixture.service);let closed=false;void closing.then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,20));expect(closed).toBe(false);
    expect(()=>new SqliteLongMemoryStore(fixture.directory)).toThrow('sqlite_owner_lease_unavailable');
    release([1,0]);await closing;
  });

  it('returns an explicit incomplete deadline result and retains ownership of unfinished native work', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:(vector:number[])=>void;const pending=new Promise<number[]>(resolve=>{release=resolve;});
    const fixture=neural(async text=>{if(text==='deadline query'){entered();return pending;}return [1,0];});
    await waitIndexed(fixture);const query=fixture.service.recall(scope,'deadline query',20,signal());await started;
    try {expect(await query).toMatchObject({complete:false,hits:[],embedding:{degraded:true,reason:null}});
      expect(await fixture.service.recall(scope,'while native is pending',20,signal())).toMatchObject({complete:false});}
    finally {release([1,0]);}
  },10000);

  it('keeps actual authoritative corruption strict rather than rebuilding source content', async () => {
    const fixture=neural(async()=>[1,0]);await fixture.service.execute('create',put(),signal());await waitIndexed(fixture);
    const database=new DatabaseSync(path.join(fixture.directory,'data/long-memory/long-memory.db'));
    try {database.prepare('UPDATE long_memories SET payload_json=?').run('{}');}finally{database.close();}
    await expect(fixture.service.recall(scope,'SQLite',20,signal())).rejects.toThrow();
    expect(()=>fixture.store.assertHealthy()).toThrow('memory_authority_integrity');
    const check=new DatabaseSync(path.join(fixture.directory,'data/long-memory/long-memory.db'),{readOnly:true});
    try {expect(check.prepare('SELECT payload_json,version FROM long_memories').get()).toMatchObject({payload_json:'{}',version:1});}finally{check.close();}
  });

  it('synchronizes reviewed instruction updates while an obsolete native document computation is still running', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:(vector:number[])=>void;const pending=new Promise<number[]>(resolve=>{release=resolve;});
    const fixture=neural(async text=>{if(text.includes('Storage decision')){entered();return pending;}return [1,0];});
    await fixture.service.execute('create',put(),signal());await started;
    try {
      await fixture.service.execute('update',{...put(),expectedVersion:1,title:'Reviewed new preference',memoryType:'preference',content:'Use the new preference'},signal());
      const instructions=await fixture.service.instructionMemories(scope,signal());
      expect(instructions).toEqual([expect.objectContaining({version:2,title:'Reviewed new preference',content:'Use the new preference'})]);
      expect((await fixture.service.recall(scope,'SQLite',20,signal())).hits).toEqual([]);
    }finally{release([1,0]);}
    await waitIndexed(fixture);
    const state=fixture.index.state()!;
    expect(fixture.index.vectorCandidates(state.spaceId,scope,[1,0],128,now.getTime()).candidates).toEqual([
      expect.objectContaining({memoryId:'memory-a',version:2})]);
  });

  it('excludes an expired source immediately and then physically retires its derived vector job', async () => {
    let current=now;const fixture=lexical(root(),()=>current);
    await fixture.service.execute('expires',put('memory-a',{retentionUntil:new Date(now.getTime()+100).toISOString()}),signal());
    await waitIndexed(fixture);current=new Date(now.getTime()+500);
    expect((await fixture.service.recall(scope,'SQLite',20,signal())).hits).toEqual([]);
    expect(await fixture.service.instructionMemories(scope,signal())).toEqual([]);
    await expect.poll(()=>{
      const database=new DatabaseSync(path.join(fixture.directory,MEMORY_INDEX_RELATIVE_PATH),{readOnly:true});
      try{return database.prepare('SELECT (SELECT count(*) FROM memory_index_vectors) AS vectors,(SELECT count(*) FROM memory_index_jobs) AS jobs').get();}finally{database.close();}
    }).toMatchObject({vectors:0,jobs:0});
    expect((await fixture.store.get('memory-a',scope,current))?.expired).toBe(true);
  });

  it('does not clear a failed document job when another document or a query embeds successfully',async()=>{
    let failA=true;
    const fixture=neural(async text=>{if(text.includes('Failure A')&&failA)throw new Error('private document failure');return [1,0];});
    await fixture.service.execute('a',put('a',{title:'Failure A'}),signal());
    await fixture.service.execute('b',put('b',{title:'Successful B'}),signal());
    await expect.poll(()=>{
      const state=fixture.index.state();return state&&!state.scanning&&fixture.index.vectorCandidates(state.spaceId,scope,[1,0],128,now.getTime()).candidates.some(candidate=>candidate.memoryId==='b');
    },{timeout:4000,interval:20}).toBe(true);
    expect(fixture.service.hasExternalFailure()).toBe(true);
    expect(await fixture.service.recall(scope,'SQLite',20,signal())).toMatchObject({complete:false,embedding:{reason:'model_unavailable'}});
    expect(fixture.service.hasExternalFailure()).toBe(true);failA=false;await waitIndexed(fixture);
    expect(fixture.service.hasExternalFailure()).toBe(false);
  });

  it('fences a still-running old computation from publication or deleting a new-generation job after index rebuild',async()=>{
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:(vector:number[])=>void;const pending=new Promise<number[]>(resolve=>{release=resolve;});
    let firstB=true,bComputations=0;
    const fixture=neural(async text=>{
      if(text.includes('Generation B')){bComputations++;if(firstB){firstB=false;entered();return pending;}}
      return [1,0];
    });
    await fixture.service.execute('a',put('a',{title:'Generation A'}),signal());
    await fixture.service.execute('b',put('b',{title:'Generation B'}),signal());await started;
    const previousTag=fixture.index.state()!.scanTag;
    const database=new DatabaseSync(path.join(fixture.directory,MEMORY_INDEX_RELATIVE_PATH));
    try{database.prepare('UPDATE memory_index_state SET space_id=?').run('invalid-derived-space');}finally{database.close();}
    try{
      await fixture.service.instructionMemories(scope,signal());
      await expect.poll(()=>{
        try{const state=fixture.index.state();return state?.scanTag!==previousTag&&state?.scanning===false;}catch{return false;}
      }).toBe(true);
    }finally{release([1,0]);}
    await waitIndexed(fixture);const state=fixture.index.state()!;
    expect(fixture.index.vectorCandidates(state.spaceId,scope,[1,0],128,now.getTime()).candidates.map(candidate=>candidate.memoryId)).toEqual(['a','b']);
    expect(bComputations).toBe(2);
    expect((await fixture.store.get('b',scope,now))?.version).toBe(1);
  });
});
