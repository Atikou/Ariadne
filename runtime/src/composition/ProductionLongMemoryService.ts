import { createHash } from 'node:crypto';
import type { LongMemoryCommand, LongMemoryContent, LongMemoryRecord, LongMemoryResult, MemoryEmbeddingStatus } from '@ariadne/protocol/public';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
import type { LongMemoryAuthority, LongMemoryMutation, LongMemoryOwnerScope } from '../control/ports/LongMemoryAuthority.js';
import { SqliteLongMemoryStore, LONG_MEMORY_DB_SCHEMA_VERSION } from '../adapters/persistence/SqliteLongMemoryStore.js';
import { LocalLexicalEmbeddingProvider, LocalGgufEmbeddingProvider, type EmbeddingProvider } from '../adapters/embedding/LocalMemoryEmbedding.js';
import type { ShutdownContext } from '../ingress/ShutdownContext.js';
import { MemoryIndexUnavailable, type SqliteLongMemoryIndexStore } from '../adapters/persistence/SqliteLongMemoryIndexStore.js';
import { MEMORY_CANDIDATE_ALGORITHM } from '../adapters/persistence/LongMemoryCandidateBuckets.js';
import { LongMemoryIndexWorker, MemoryEmbeddingUnavailable, MemoryEmbeddingBusy } from './LongMemoryIndexWorker.js';

type Recall = Extract<LongMemoryResult, { kind: 'memory.recall_result' }>;
type Hit = Recall['hits'][number];
/** Uses one explicit local embedding space; model failure is public and does not relabel lexical evidence as semantic. */
export class ProductionLongMemoryService implements LongMemoryAuthority {
  public readonly schemaVersion = LONG_MEMORY_DB_SCHEMA_VERSION;
  private readonly stopping = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly nativeActive = new Set<Promise<unknown>>();
  private modelUnavailable = false;
  private documentModelUnavailable = false;
  private closeOperation: Promise<void> | null = null;
  private readonly spaceId: string;
  private readonly index: SqliteLongMemoryIndexStore;
  private readonly worker: LongMemoryIndexWorker;
  private embeddingBusy = false;
  public constructor(private readonly store: SqliteLongMemoryStore, private readonly embedding: EmbeddingProvider,
    private readonly policy: RuntimePolicySnapshot['embedding'], private readonly now = () => new Date(Date.now())) {
    validateEmbedding(embedding, policy);
    this.spaceId = `sha256:${createHash('sha256').update(JSON.stringify({ algorithm: 'provider-token-bound-pooling-v1', provider: policy.provider,
      modelId: policy.provider === 'local-gguf' ? policy.modelId : null, sha256: policy.provider === 'local-gguf' ? policy.sha256 : null,
      dimension: embedding.dimension, candidateAlgorithm: MEMORY_CANDIDATE_ALGORITHM })).digest('hex')}`;
    this.index = store.openSearchIndex();
    this.worker = new LongMemoryIndexWorker(store, this.index, this.spaceId, embedding.dimension, now,
      text => this.embed(text, this.stopping.signal), (failed,actualSuccess) => { this.documentModelUnavailable = failed; if(actualSuccess)this.modelUnavailable = false; });
  }
  public assertHealthy(): void { this.store.assertHealthy(); this.worker.assertHealthy(); }
  public hasExternalFailure(): boolean { return this.policy.provider === 'local-gguf' && (this.modelUnavailable || this.documentModelUnavailable); }
  public execute(commandId: string, command: LongMemoryCommand, signal: AbortSignal): Promise<LongMemoryResult> {
    if (command.kind === 'memory.recall') return this.recall(command, command.query, command.limit, signal);
    return this.operation(signal, async joined => {
      let result: LongMemoryResult;
      if (command.kind === 'memory.query') result = await this.store.query(command, this.now());
      else if (command.kind === 'memory.read') result = { kind: 'memory.read_result', memory: await this.store.get(command.memoryId, command, this.now()) };
      else result = await this.store.execute(commandId, command, this.now(), joined);
      if (command.kind !== 'memory.query' && command.kind !== 'memory.read') this.worker.wake();
      joined.throwIfAborted(); return result;
    });
  }
  public reconcile(commandId: string, command: LongMemoryMutation): Promise<LongMemoryResult | null> { return this.store.reconcile(commandId, command); }
  public stageCandidate(commandId: string, input: LongMemoryOwnerScope & LongMemoryContent & { readonly memoryId: string; readonly runId: string }, signal: AbortSignal): Promise<LongMemoryResult> {
    return this.operation(signal, async joined => { joined.throwIfAborted(); const result = await this.store.stageCandidate(commandId, input, this.now(), joined); this.worker.wake(); joined.throwIfAborted(); return result; });
  }
  public recall(scope: LongMemoryOwnerScope, query: string, limit: number, signal: AbortSignal): Promise<Recall> {
    const deadline = AbortSignal.timeout(5_000);
    const querySignal = AbortSignal.any([signal, deadline]);
    return awaitMemorySignal(this.operation(querySignal, async joined => {
      const hits = new Map<string, Hit>();
      const lexical = await this.store.lexicalSearch(scope, query, Math.min(100, limit * 4), this.now());
      for (const [index, hit] of lexical.entries()) hits.set(hit.memory.memoryId, { memory: hit.memory,
        score: 0.65 / (index + 1) + hit.memory.importance * 0.2 + hit.memory.confidence * 0.1, reason: 'lexical' });
      let complete = this.worker.ready;
      let incompleteReason: MemoryEmbeddingStatus['reason'] = 'index_rebuild_required';
      if (!complete) return this.finalize(scope, hits, limit, false, joined);
      try {
        const queryVector = await this.embed(query, joined);
        this.modelUnavailable = false;
        const selected = this.index.vectorCandidates(this.spaceId, scope, queryVector, 128, this.now().getTime());
        complete = selected.complete && this.worker.ready;
        if(selected.limited)incompleteReason=null;
        for (const candidate of selected.candidates) {
          joined.throwIfAborted(); const memory = await this.store.get(candidate.memoryId, scope, this.now());
          if (!memory || memory.version !== candidate.version || memory.status !== 'active' || memory.reviewedAt === null || memory.expired) { complete = false; continue; }
          const relevance = cosine(queryVector, candidate.vector); if (relevance <= 0.05) continue;
          const score = relevance * 0.7 + memory.importance * 0.2 + memory.confidence * 0.1;
          const prior = hits.get(memory.memoryId);
          hits.set(memory.memoryId, { memory, score: Math.max(prior?.score ?? 0, score),
            reason: this.policy.provider === 'lexical' ? 'lexical' : prior ? 'hybrid' : 'semantic' });
        }
      } catch (error) {
        joined.throwIfAborted(); complete = false;
        if (error instanceof MemoryEmbeddingUnavailable) this.modelUnavailable = true;
        else if (error instanceof MemoryIndexUnavailable) this.worker.rebuild();
        else if (error instanceof MemoryEmbeddingBusy) incompleteReason=null;
        else throw error;
      }
      return this.finalize(scope, hits, limit, complete, joined, incompleteReason);
    }), querySignal).catch(error => {
      signal.throwIfAborted(); this.stopping.signal.throwIfAborted();
      if (!deadline.aborted || error !== deadline.reason) throw error;
      return {kind:'memory.recall_result',hits:[],embedding:this.status(false,null),complete:false};
    });
  }
  public instructionMemories(scope: LongMemoryOwnerScope, signal: AbortSignal): Promise<readonly LongMemoryRecord[]> {
    const deadline = AbortSignal.timeout(5_000);
    const querySignal = AbortSignal.any([signal, deadline]);
    return awaitMemorySignal(this.operation(querySignal, async joined => {
      if (!await this.worker.waitMetadata(joined)) return [];
      const selected: LongMemoryRecord[] = [];
      try {
        for (const candidate of this.index.instructionCandidates(scope, this.now().getTime())) {
          joined.throwIfAborted(); const memory = await this.store.get(candidate.memoryId, scope, this.now());
          if (memory?.version === candidate.version && memory.status === 'active' && memory.reviewedAt !== null && !memory.expired) selected.push(memory);
        }
      } catch (error) {
        if (!(error instanceof MemoryIndexUnavailable)) throw error;
        this.worker.rebuild(); return [];
      }
      return (await this.current(scope, selected, joined)).map(memory => ({ ...memory,
        content: memory.content.length > 1_024 ? memory.content.slice(0, 1_024) + '【记忆已截断，请使用记忆召回读取完整内容】' : memory.content }));
    }), querySignal).catch(error => {
      signal.throwIfAborted(); this.stopping.signal.throwIfAborted();
      if (!deadline.aborted || error !== deadline.reason) throw error; return [];
    });
  }
  public prepareShutdown(context: ShutdownContext): void { this.stopping.abort(new Error('long_memory_stopping')); void this.worker.stop(); this.store.prepareShutdown(context); }
  public close(context: ShutdownContext): Promise<void> {
    this.closeOperation ??= this.closeOwned(context); return this.closeOperation;
  }
  private async closeOwned(context: ShutdownContext): Promise<void> {
    this.prepareShutdown(context); await joinOwnedMemoryOperation(Promise.allSettled([...this.active, ...this.nativeActive, this.worker.stop()]), context);
    if (this.embedding instanceof LocalGgufEmbeddingProvider) await joinOwnedMemoryOperation(this.embedding.dispose(), context);
    this.index.close(); await this.store.close(context);
  }
  private operation<T>(signal: AbortSignal, execute: (joined: AbortSignal) => Promise<T>): Promise<T> {
    const joined = AbortSignal.any([signal, this.stopping.signal]);
    const promise = Promise.resolve().then(() => { joined.throwIfAborted(); return execute(joined); });
    this.active.add(promise); void promise.then(() => this.active.delete(promise), () => this.active.delete(promise)); return promise;
  }
  private async embed(text: string, signal: AbortSignal): Promise<readonly number[]> {
      signal.throwIfAborted(); if (this.embeddingBusy) throw new MemoryEmbeddingBusy();
      this.embeddingBusy = true;
      const operation = (async () => {
        let vector: readonly number[];
        try { vector = await this.embedding.embedText(text); }
        catch (error) { throw new MemoryEmbeddingUnavailable('long_memory_model_unavailable', { cause: error }); }
        if (vector.length !== this.embedding.dimension || !vector.every(Number.isFinite)) throw new MemoryEmbeddingUnavailable('long_memory_vector_contract_invalid');
        const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
        if (scale === 0) return vector;
        const scaled = vector.map(value => value / scale), magnitude = Math.sqrt(scaled.reduce((total, value) => total + value * value, 0));
        return scaled.map(value => value / magnitude);
      })();
      this.nativeActive.add(operation);
      const settled = () => { this.embeddingBusy = false; this.nativeActive.delete(operation); };
      void operation.then(settled, settled);
      return awaitMemorySignal(operation, signal);
  }
  private async current(scope: LongMemoryOwnerScope, memories: readonly LongMemoryRecord[], signal: AbortSignal): Promise<LongMemoryRecord[]> {
    const result: LongMemoryRecord[] = [];
    for (const memory of memories) { signal.throwIfAborted(); const current = await this.store.get(memory.memoryId, scope, this.now());
      if (current?.version === memory.version && current.status === 'active' && current.reviewedAt !== null && !current.expired) result.push(current); }
    signal.throwIfAborted(); return result;
  }
  private async finalize(scope: LongMemoryOwnerScope, hits: ReadonlyMap<string, Hit>, limit: number, complete: boolean, signal: AbortSignal,
    incompleteReason: MemoryEmbeddingStatus['reason']='index_rebuild_required'): Promise<Recall> {
    const ordered = [...hits.values()].sort((left, right) => right.score - left.score || left.memory.memoryId.localeCompare(right.memory.memoryId));
    const current = new Map((await this.current(scope, ordered.map(hit => hit.memory), signal)).map(memory => [memory.memoryId, memory]));
    if (current.size !== hits.size) complete = false;
    return { kind: 'memory.recall_result', hits: ordered.filter(hit => current.has(hit.memory.memoryId)).slice(0, limit)
      .map(hit => ({ ...hit, memory: current.get(hit.memory.memoryId)!, score: Math.min(1, Math.max(0, hit.score)) })), embedding: this.status(complete,incompleteReason), complete };
  }
  private status(complete: boolean,incompleteReason: MemoryEmbeddingStatus['reason']='index_rebuild_required'): MemoryEmbeddingStatus {
    const semantic = this.policy.provider === 'local-gguf';
    const modelFailed = this.modelUnavailable || this.documentModelUnavailable;
    return { provider: this.policy.provider, capability: semantic ? 'semantic' : 'lexical_approximation', dimension: this.embedding.dimension,
      modelId: semantic ? this.policy.modelId : null, degraded: !semantic || modelFailed || !complete,
      reason: !semantic ? 'lexical_approximation_not_semantic' : modelFailed ? 'model_unavailable' : !complete ? incompleteReason : null };
  }
}
export function createProductionLongMemoryService(dataRoot: string, policy: RuntimePolicySnapshot['embedding']): ProductionLongMemoryService {
  const embedding = policy.provider === 'lexical' ? new LocalLexicalEmbeddingProvider() : new LocalGgufEmbeddingProvider(policy);
  validateEmbedding(embedding, policy);
  return new ProductionLongMemoryService(new SqliteLongMemoryStore(dataRoot), embedding, policy);
}
function validateEmbedding(embedding: EmbeddingProvider, policy: RuntimePolicySnapshot['embedding']): void {
  if (!Number.isInteger(embedding.dimension) || embedding.dimension < 1 || embedding.dimension > 65_536
    || (policy.provider === 'local-gguf' && (embedding.capability !== 'semantic' || embedding.dimension !== policy.dimension))
    || (policy.provider === 'lexical' && embedding.capability !== 'lexical_approximation') || embedding.remote) throw new Error('long_memory_embedding_contract_invalid');
}
function joinOwnedMemoryOperation(operation: Promise<unknown>, context: ShutdownContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('long_memory_close_deadline')); };
    const cleanup = () => context.signal.removeEventListener('abort', abort);
    operation.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    try { context.throwIfExpired('long_memory_close_deadline'); } catch (error) { reject(error); return; }
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) { abort(); return; }
  });
}
function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error('long_memory_vector_dimension_conflict');
  let dot = 0; let a = 0; let b = 0; for (let index = 0; index < left.length; index++) { dot += left[index]! * right[index]!; a += left[index]! ** 2; b += right[index]! ** 2; }
  return a > 0 && b > 0 ? Math.max(0, Math.min(1, dot / Math.sqrt(a * b))) : 0;
}
/** Cancellation ends the caller wait. The native capacity/lease remains owned
 * until the actual provider promise settles, and close joins it separately. */
function awaitMemorySignal<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)abort();
  });
}
