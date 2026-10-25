import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublicProjectionChange, RuntimeCommand, RuntimeResult, RuntimeStatus, RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { SqlitePublicProjectionStore, type PublicProjectionPersistenceClock } from '../../../runtime/src/adapters/persistence/SqlitePublicProjectionStore';
import { readAgentProjectionQuery } from '../../../runtime/src/composition/agent-entity/components/projection/AgentProjectionQueries';
import { RuntimeStore } from '../../../app/src/renderer/src/core/runtime/runtime-store';
import { successfulRuntimeApi } from '../../../app/tests/support/runtime-api';
import type { AriadneApi, Result, RuntimeDesktopRequestOptions } from '../../../app/src/shared/contract';
import { NOW } from '../../../app/tests/projection-v3-fixture';

const fixtures: ProjectionRuntimeHarness[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

/** Cross-workspace tests use the actual public query owner and durable SQLite
 * history. Hooks delay or corrupt public responses without a legacy read fallback. */
export class ProjectionRuntimeHarness {
  readonly root = mkdtempSync(path.join(tmpdir(), 'ariadne-renderer-runtime-'));
  backend: SqlitePublicProjectionStore;
  readonly renderer: RuntimeStore;
  readonly commands: RuntimeCommand[] = [];
  readonly order: string[] = [];
  private cursor = 0;
  private eventListener: ((event: RuntimeEventEnvelope) => void) | null = null;
  private statusListener: ((status: RuntimeStatus) => void) | null = null;
  activeSubscriptions = 0;
  status: RuntimeStatus = { availability: 'ready', capabilities: [], observedAt: NOW };
  queryStatus: () => Promise<RuntimeStatus> = async () => this.status;
  request: (command: RuntimeCommand, read: () => Promise<RuntimeResult>, options?: RuntimeDesktopRequestOptions) => Promise<RuntimeResult> = async (_command, read) => read();
  requestFailure: (command: RuntimeCommand, options?: RuntimeDesktopRequestOptions) => Result<RuntimeResult> | null = () => null;

  constructor(persistence?: AriadneApi['agentInputDeliveryOutbox'], clock?: PublicProjectionPersistenceClock) {
    this.backend = new SqlitePublicProjectionStore(this.root, clock);
    const api = successfulRuntimeApi({
      getStatus: () => this.queryStatus(),
      request: async (command, options) => {
        return this.request(command, () => readAgentProjectionQuery(this.backend, command), options);
      },
      onEvent: listener => {
        this.order.push('subscribe'); this.activeSubscriptions++; this.eventListener = listener;
        return () => { this.activeSubscriptions--; if (this.eventListener === listener) this.eventListener = null; };
      },
      onStatus: listener => { this.statusListener = listener; return () => { if (this.statusListener === listener) this.statusListener = null; }; }
    });
    this.renderer = new RuntimeStore({ ...api, request: (command, options) => {
      this.commands.push(command); this.order.push(command.kind);
      if (command.kind === 'projection.snapshot.get' || command.kind === 'projection.commits.read') throw new Error('legacy_projection_read_forbidden');
      const failure = this.requestFailure(command, options);
      return failure === null ? api.request(command, options) : Promise.resolve(failure);
    } }, persistence);
    fixtures.push(this);
  }
  async append(changes: readonly PublicProjectionChange[]): Promise<void> {
    this.cursor += 1;
    await this.backend.append({ contractVersion: '5.0', sourceId: 'test-source', sourceCursor: this.cursor,
      eventId: `test-event-${this.cursor}`, occurredAt: NOW, changes: [...changes] });
  }
  event(event: RuntimeEventEnvelope): void { this.eventListener?.(event); }
  emitStatus(status: RuntimeStatus): void { this.status = status; this.statusListener?.(status); }
  async close(): Promise<void> { this.renderer.dispose(); await this.backend.close(); rmSync(this.root, { recursive: true, force: true }); }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
