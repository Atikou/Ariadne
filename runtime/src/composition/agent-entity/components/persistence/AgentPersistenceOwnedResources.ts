import type { AgentPersistenceComponentHandle } from './AgentPersistenceComponentContract.js';
import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqlitePublicProjectionStore } from '../../../../adapters/persistence/SqlitePublicProjectionStore.js';
import type { SqliteProductivityStore } from '../../../../adapters/persistence/SqliteProductivityStore.js';
import type { LocalConversationAttachmentStore } from '../../../../adapters/attachment/LocalConversationAttachmentStore.js';
import type { FileAgentSubagentSessionStore } from '../../../../adapters/subagent/FileAgentSubagentSessionStore.js';
import type { AesGcmAgentPersistencePayloadCodec } from '../../../../adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import type { SqliteTaskQuerySnapshotStore } from '../../../../adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';

export class DefaultAgentPersistenceComponentHandle implements AgentPersistenceComponentHandle {
  private closed = false;

  public constructor(
    public readonly unitOfWork: SqliteAgentRunUnitOfWork,
    public readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    public readonly publicProjection: SqlitePublicProjectionStore,
    public readonly productivity: SqliteProductivityStore | undefined,
    public readonly attachmentStore: LocalConversationAttachmentStore,
    public readonly subagentSessionStore: FileAgentSubagentSessionStore,
    private readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec,
    public readonly taskQuerySnapshots?: SqliteTaskQuerySnapshotStore
  ) {}

  public prepareShutdown(context: ShutdownContext): void {
    const failures: unknown[] = [];
    for (const prepare of [
      () => this.unitOfWork.prepareShutdown(context),
      () => this.conversation.prepareShutdown(context),
      () => this.productivity?.prepareShutdown(context)
    ]) {
      try {
        prepare();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'agent_persistence_prepare_shutdown_failed');
    }
  }

  public async close(context: ShutdownContext): Promise<void> {
    if (this.closed) {
      context.throwIfExpired();
      return;
    }
    context.throwIfExpired(); this.taskQuerySnapshots?.close();
    await this.publicProjection.close(context);
    await this.productivity?.close(context);
    await this.conversation.close(context);
    await this.unitOfWork.close(context);
    this.encryptedCodec?.destroy();
    this.closed = true;
  }

  public async rollback(context: ShutdownContext): Promise<readonly unknown[]> {
    if (this.closed) return Object.freeze([]);
    const failures = await rollbackPartial({
      unitOfWork: this.unitOfWork,
      conversation: this.conversation,
      publicProjection: this.publicProjection,
      productivity: this.productivity,
      taskQuerySnapshots: this.taskQuerySnapshots,
      encryptedCodec: this.encryptedCodec
    }, context);
    this.closed = true;
    return failures;
  }
}

export async function rollbackPartial(
  resources: {
    readonly unitOfWork?: SqliteAgentRunUnitOfWork;
    readonly conversation?: SqliteConversationRunHandoffUnitOfWork;
    readonly publicProjection?: SqlitePublicProjectionStore;
    readonly productivity?: SqliteProductivityStore;
    readonly taskQuerySnapshots?: SqliteTaskQuerySnapshotStore;
    readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec;
  },
  context: ShutdownContext
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const close of [
    () => resources.taskQuerySnapshots?.close(),
    () => resources.publicProjection?.close(context),
    () => resources.productivity?.close(context),
    () => resources.conversation?.close(context),
    () => resources.unitOfWork?.close(context)
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    resources.encryptedCodec?.destroy();
  } catch (error) {
    failures.push(error);
  }
  return Object.freeze(failures);
}
