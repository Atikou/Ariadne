import { assertCanonicalAbsoluteDataRoot } from '@ariadne/protocol/host';
import type { AgentPersistencePayloadCodec } from '@ariadne/agent-core';

import {
  AES_GCM_AGENT_PERSISTENCE_CODEC_ID,
  AesGcmAgentPersistencePayloadCodec
} from '../../../../adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  SqliteConversationRunHandoffUnitOfWork
} from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import {
  StrictJsonAgentPersistencePayloadCodec
} from '../../../../adapters/persistence/StrictJsonAgentPersistencePayloadCodec.js';
import {
  SqlitePublicProjectionStore
} from '../../../../adapters/persistence/SqlitePublicProjectionStore.js';
import { SqliteProductivityStore } from '../../../../adapters/persistence/SqliteProductivityStore.js';
import {
  LocalConversationAttachmentStore
} from '../../../../adapters/attachment/LocalConversationAttachmentStore.js';
import {
  FileAgentSubagentSessionStore
} from '../../../../adapters/subagent/FileAgentSubagentSessionStore.js';
import type { AgentControlRuntimeFactoryInput } from '../../../../ingress/AgentControlLifecycle.js';
import {
  createShutdownContext,
  type ShutdownContext
} from '../../../../ingress/ShutdownContext.js';
import { loadAgentPersistenceKeyRing } from '../../../loadAgentPersistenceKeyRing.js';

export interface AgentPersistenceComponentHandle {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly publicProjection: SqlitePublicProjectionStore;
  readonly productivity?: SqliteProductivityStore;
  readonly attachmentStore: LocalConversationAttachmentStore;
  readonly subagentSessionStore: FileAgentSubagentSessionStore;
  prepareShutdown(context: ShutdownContext): void;
  close(context: ShutdownContext): Promise<void>;
  rollback(context: ShutdownContext): Promise<readonly unknown[]>;
}

export interface AgentPersistenceComponentResources {
  readonly dataRoot: string;
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly publicProjection: SqlitePublicProjectionStore;
  readonly productivity?: SqliteProductivityStore;
  readonly attachmentStore?: LocalConversationAttachmentStore;
  readonly subagentSessionStore?: FileAgentSubagentSessionStore;
  readonly persistenceCodec?: AgentPersistencePayloadCodec;
  readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec;
}

/** Compose an already-open owner set into the same handle used by production. */
export function composeAgentPersistenceComponentHandle(
  resources: AgentPersistenceComponentResources
): AgentPersistenceComponentHandle {
  const persistenceCodec = resources.persistenceCodec
    ?? new StrictJsonAgentPersistencePayloadCodec();
  return new DefaultAgentPersistenceComponentHandle(
    resources.unitOfWork,
    resources.conversation,
    resources.publicProjection,
    resources.productivity,
    resources.attachmentStore ?? new LocalConversationAttachmentStore(resources.dataRoot),
    resources.subagentSessionStore ?? new FileAgentSubagentSessionStore(
      resources.dataRoot,
      persistenceCodec
    ),
    resources.encryptedCodec
  );
}

/** Required Agent component that owns the complete persistence resource set. */
export async function startAgentPersistenceComponent(
  input: Pick<
    AgentControlRuntimeFactoryInput,
    'dataRoot' | 'hostCapabilities' | 'production' | 'runtimeInstanceId'
  >
): Promise<AgentPersistenceComponentHandle> {
  assertCanonicalAbsoluteDataRoot(input.dataRoot);
  const temporaryKeys: Array<{ readonly keyId: string; readonly key: Buffer }> = [];
  let encryptedCodec: AesGcmAgentPersistencePayloadCodec | undefined;
  let unitOfWork: SqliteAgentRunUnitOfWork | undefined;
  let conversation: SqliteConversationRunHandoffUnitOfWork | undefined;
  let publicProjection: SqlitePublicProjectionStore | undefined;
  let productivity: SqliteProductivityStore | undefined;
  try {
    const productionPersistence = input.production
      ? await createProductionCodec(input, temporaryKeys)
      : undefined;
    const persistenceCodec = productionPersistence?.codec
      ?? new StrictJsonAgentPersistencePayloadCodec();
    encryptedCodec = productionPersistence?.codec;
    unitOfWork = new SqliteAgentRunUnitOfWork(input.dataRoot, persistenceCodec);
    if (productionPersistence !== undefined) {
      const { keyRing } = productionPersistence;
      await unitOfWork.verifyOrInitializeKeyringAnchor({
        generation: keyRing.generation,
        activeKeyId: keyRing.activeKeyId,
        availableKeyIds: keyRing.keys.map((entry) => entry.keyId),
        requiredCodecId: AES_GCM_AGENT_PERSISTENCE_CODEC_ID
      });
    }
    conversation = new SqliteConversationRunHandoffUnitOfWork(input.dataRoot);
    productivity = new SqliteProductivityStore(input.dataRoot);
    publicProjection = new SqlitePublicProjectionStore(input.dataRoot);
    return composeAgentPersistenceComponentHandle({
      dataRoot: input.dataRoot,
      unitOfWork,
      conversation,
      publicProjection,
      productivity,
      persistenceCodec,
      encryptedCodec
    });
  } catch (error) {
    const cleanupContext = createShutdownContext(Date.now() + 5_000);
    let cleanupFailures: readonly unknown[];
    try {
      cleanupFailures = await rollbackPartial({
        unitOfWork,
        conversation,
        publicProjection,
        productivity,
        encryptedCodec
      }, cleanupContext);
    } finally {
      cleanupContext.dispose();
    }
    throw cleanupFailures.length === 0
      ? error
      : new AggregateError(
          [error, ...cleanupFailures],
          'agent_persistence_component_start_cleanup_failed'
        );
  } finally {
    for (const entry of temporaryKeys) entry.key.fill(0);
  }
}

class DefaultAgentPersistenceComponentHandle implements AgentPersistenceComponentHandle {
  private closed = false;

  public constructor(
    public readonly unitOfWork: SqliteAgentRunUnitOfWork,
    public readonly conversation: SqliteConversationRunHandoffUnitOfWork,
    public readonly publicProjection: SqlitePublicProjectionStore,
    public readonly productivity: SqliteProductivityStore | undefined,
    public readonly attachmentStore: LocalConversationAttachmentStore,
    public readonly subagentSessionStore: FileAgentSubagentSessionStore,
    private readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec
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
      encryptedCodec: this.encryptedCodec
    }, context);
    this.closed = true;
    return failures;
  }
}

async function createProductionCodec(
  input: Pick<AgentControlRuntimeFactoryInput, 'hostCapabilities' | 'runtimeInstanceId'>,
  temporaryKeys: Array<{ readonly keyId: string; readonly key: Buffer }>
): Promise<{
  readonly codec: AesGcmAgentPersistencePayloadCodec;
  readonly keyRing: Awaited<ReturnType<typeof loadAgentPersistenceKeyRing>>;
}> {
  const keyRing = await loadAgentPersistenceKeyRing(
    input.hostCapabilities,
    input.runtimeInstanceId
  );
  temporaryKeys.push(...keyRing.keys.map((entry) => ({
    keyId: entry.keyId,
    key: Buffer.from(entry.keyMaterialBase64, 'base64')
  })));
  return {
    codec: new AesGcmAgentPersistencePayloadCodec(keyRing.activeKeyId, temporaryKeys),
    keyRing
  };
}

async function rollbackPartial(
  resources: {
    readonly unitOfWork?: SqliteAgentRunUnitOfWork;
    readonly conversation?: SqliteConversationRunHandoffUnitOfWork;
    readonly publicProjection?: SqlitePublicProjectionStore;
    readonly productivity?: SqliteProductivityStore;
    readonly encryptedCodec?: AesGcmAgentPersistencePayloadCodec;
  },
  context: ShutdownContext
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const close of [
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
