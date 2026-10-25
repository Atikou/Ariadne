import type { SqliteLongMemoryStore } from '../adapters/persistence/SqliteLongMemoryStore.js';
import { MemoryIndexUnavailable, type SqliteLongMemoryIndexStore, type MemoryIndexJob } from '../adapters/persistence/SqliteLongMemoryIndexStore.js';

export class MemoryEmbeddingUnavailable extends Error {}
export class MemoryEmbeddingBusy extends Error {}

/** One background owner. Durable receipts discover changes; durable jobs own
 * document computations. Each turn scans one metadata page and computes at
 * most one vector. Neither operation runs inside a foreground recall. */
export class LongMemoryIndexWorker {
  private timer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null = null;
  private immediate = false;
  private running: Promise<boolean> | null = null;
  private computing: Promise<void> | null = null;
  private readonly metadataWaiters = new Set<() => void>();
  private stopped = false;
  private initialized = false;
  private failure: unknown = null;
  private rebuildRequested = false;
  private needsTurn = false;
  private metadataCurrent = false;
  private modelRetryAt = 0;
  private modelAttempts = 0;
  private indexRecoveries = 0;
  public get ready(): boolean { return this.metadataCurrent && !this.failure && this.index.available; }
  waitMetadata(signal:AbortSignal):Promise<boolean> {
    if(this.ready)return Promise.resolve(true);
    if(this.stopped||this.failure||!this.index.available)return Promise.resolve(false);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.metadataWaiters.delete(check);signal.removeEventListener('abort',abort);};
      const check=()=>{if(this.ready||this.stopped||this.failure){cleanup();resolve(this.ready);}};
      const abort=()=>{cleanup();reject(signal.reason);};
      this.metadataWaiters.add(check);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else check();
    });
  }
  constructor(private readonly source: SqliteLongMemoryStore, private readonly index: SqliteLongMemoryIndexStore,
    private readonly spaceId: string, private readonly dimension: number, private readonly now: () => Date,
    private readonly embed: (text: string) => Promise<readonly number[]>, private readonly modelFailure: (failed: boolean, actualSuccess:boolean) => void) {
    if (index.available) this.wake();
  }
  wake(): void {
    if (this.stopped || this.failure || !this.index.available) return;
    this.metadataCurrent = false; this.needsTurn = true;
    if (this.running) return;
    this.clearTimer();
    this.schedule(0);
  }
  rebuild(): void {
    if(this.failure instanceof MemoryIndexUnavailable)this.failure=null;
    this.rebuildRequested = true; this.wake();
  }
  stop(): Promise<void> {
    this.stopped = true; this.metadataCurrent = false;
    this.notifyMetadata();
    this.clearTimer();
    return Promise.allSettled([this.running,this.computing]).then(() => undefined);
  }
  assertHealthy(): void { if (this.failure && !(this.failure instanceof MemoryIndexUnavailable)) throw this.failure; }
  private schedule(delay: number): void {
    if (this.stopped || this.failure) return;
    const turn = () => {
      this.timer = null; this.needsTurn = false;
      const operation = this.turn().catch(error => { if (this.stopped) return false; throw error; }); this.running = operation;
      void operation.then(more => this.finish(more), error => this.finish(this.observeFailure(error)));
    };
    // setImmediate yields one complete event-loop turn without introducing a
    // Windows timer quantum for every individual indexed record.
    this.immediate = delay === 0;
    this.timer = this.immediate ? setImmediate(turn) : setTimeout(turn, delay);
    // Pending batches keep their immediate scheduled turn referenced. An
    // unreferenced immediate can otherwise sleep until unrelated I/O arrives.
    // Idle polling does not keep the Runtime process alive on its own.
    if(delay>0)this.timer.unref();
  }
  private clearTimer():void {
    if(!this.timer)return;
    if(this.immediate)clearImmediate(this.timer as ReturnType<typeof setImmediate>);
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer=null;
  }
  private finish(more: boolean): void {
    this.running = null;
    this.schedule(more || this.needsTurn ? 0 : 250);
  }
  private observeFailure(error:unknown):boolean {
    this.metadataCurrent=false;
    if(error instanceof MemoryIndexUnavailable&&this.index.available&&this.indexRecoveries++===0){
      try{this.index.reset();this.initialized=false;this.rebuildRequested=false;this.failure=null;return true;}
      catch(rebuildError){error=rebuildError;}
    }
    this.failure=error;this.notifyMetadata();return false;
  }
  private async turn(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.rebuildRequested) { this.index.reset(); this.initialized = false; this.rebuildRequested = false; }
    if (!this.initialized) {
      const page = await this.source.indexChanges({ sequence: 0, commandId: null }, 1);
      if (this.stopped) return false;
      this.index.beginBootstrap(this.spaceId, this.dimension, page.head); this.initialized = true;
    }
    let state = this.index.state()!;
    if (state.scanning) {
      const page = await this.source.indexMetadataPage(state.scanAfter, 256);
      if (this.stopped) return false;
      this.index.applyMetadataPage(page, state.scanTag, page.at(-1)?.memoryId ?? state.scanAfter, this.now().getTime());
      if (page.length < 256) this.index.finishBootstrap(state.scanTag);
      return true;
    }
    const changes = await this.source.indexChanges(state.cursor, 128);
    if (this.stopped) return false;
    if (changes.resetRequired) {
      this.metadataCurrent = false; this.index.beginBootstrap(this.spaceId, this.dimension, changes.head); return true;
    }
    if (changes.changes.length) {
      const metadata = await this.source.indexMetadataFor(changes.changes.map(change => change.memoryId));
      if (this.stopped) return false;
      const last = changes.changes.at(-1)!;
      this.index.applyChanges(metadata, { sequence: last.sequence, commandId: last.commandId }, this.now().getTime());
      if (last.sequence !== changes.head.sequence) return true;
    }
    this.metadataCurrent = true;
    this.modelFailure(this.index.hasFailedIndexJobs(this.now().getTime()),false);
    this.notifyMetadata();
    if(this.index.pruneOldSpaces()===128)return true;
    if (this.computing || Date.now() < this.modelRetryAt) return false;
    const job = this.index.claimJob(); if (!job) return false;
    const operation=this.processJob(job,state.scanTag);this.computing=operation;
    void operation.then(()=>{this.computing=null;if(!this.stopped)this.wake();},error=>{
      this.computing=null;if(this.observeFailure(error))this.wake();
    });
    return false;
  }
  private notifyMetadata():void {for(const check of [...this.metadataWaiters])check();}
  private async processJob(job:MemoryIndexJob,scanTag:string):Promise<void> {
    const ownsGeneration=()=>this.index.state()?.scanTag===scanTag;
    try {
      const memory = await this.source.indexSource(job.memoryId, job.version, this.now());
      if(!ownsGeneration())return;
      if (this.stopped) { this.index.releaseJob(job); return; }
      if (!memory) { this.index.removeObsoleteJob(job); return; }
      if (job.kind === 'expire') {
        // Domain time can move independently of wall time; never expire early.
        this.index.releaseJob(job, Math.max(100, Date.parse(memory.retentionUntil!) - this.now().getTime())); return;
      }
      const vector = await this.embed(memory.title + '\n' + memory.content);
      if(!ownsGeneration())return;
      if (this.stopped) { this.index.releaseJob(job); return; }
      const published = await this.source.publishIndexIfCurrent(job.memoryId, job.version, this.now(),
        () => ownsGeneration()&&this.index.publishVector(job, vector, this.now().getTime()));
      if (!published&&ownsGeneration()) this.index.removeObsoleteJob(job);
      this.modelAttempts = 0; this.modelRetryAt = 0;
      this.modelFailure(this.index.hasFailedIndexJobs(this.now().getTime()),true); return;
    } catch (error) {
      if(!ownsGeneration())return;
      if(this.stopped){this.index.releaseJob(job);return;}
      if (error instanceof MemoryEmbeddingBusy) { this.index.releaseJob(job); return; }
      if (!(error instanceof MemoryEmbeddingUnavailable)) throw error;
      this.index.retryJob(job); this.modelRetryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(this.modelAttempts++, 5));
      this.modelFailure(true,false); return;
    }
  }
}
