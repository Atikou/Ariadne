import type { AgentPersistenceComponentHandle } from './AgentPersistenceComponentContract.js';
export type { AgentPersistenceComponentHandle } from './AgentPersistenceComponentContract.js';
import { DefaultAgentPersistenceComponentHandle, rollbackPartial } from './AgentPersistenceOwnedResources.js';
import { SqliteTaskQuerySnapshotStore } from '../../../../adapters/persistence/SqliteTaskQuerySnapshotStore.js';
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
import { openOptionalProductivityAuthority } from '../../../../adapters/persistence/OpenOptionalProductivityAuthority.js';
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
import type { RuntimeStartupTrace } from '../../../RuntimeStartupTrace.js';

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
    resources.encryptedCodec,
    new SqliteTaskQuerySnapshotStore(resources.dataRoot)
  );
}

/** Required Agent component that owns the complete persistence resource set. */
export async function startAgentPersistenceComponent(
  input: Pick<
    AgentControlRuntimeFactoryInput,
    'dataRoot' | 'hostCapabilities' | 'production' | 'runtimeInstanceId'
  >,
  startupTrace?: RuntimeStartupTrace
): Promise<AgentPersistenceComponentHandle> {
  assertCanonicalAbsoluteDataRoot(input.dataRoot);
  const temporaryKeys: Array<{ readonly keyId: string; readonly key: Buffer }> = [];
  let encryptedCodec: AesGcmAgentPersistencePayloadCodec | undefined;
  let unitOfWork: SqliteAgentRunUnitOfWork | undefined;
  let conversation: SqliteConversationRunHandoffUnitOfWork | undefined;
  let publicProjection: SqlitePublicProjectionStore | undefined;
  let productivity: SqliteProductivityStore | undefined;
  try {
    startupTrace?.point('persistence_keyring');
    const productionPersistence = input.production
      ? await createProductionCodec(input, temporaryKeys)
      : undefined;
    const persistenceCodec = productionPersistence?.codec
      ?? new StrictJsonAgentPersistencePayloadCodec();
    encryptedCodec = productionPersistence?.codec;
    startupTrace?.point('agent_store_open');
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
    startupTrace?.point('conversation_store_open');
    conversation = new SqliteConversationRunHandoffUnitOfWork(input.dataRoot);
    startupTrace?.point('productivity_store_open');
    productivity = openOptionalProductivityAuthority(input.dataRoot);
    startupTrace?.point('public_projection_store_open');
    publicProjection = new SqlitePublicProjectionStore(input.dataRoot, undefined, undefined,
      startupTrace === undefined ? undefined : stage => startupTrace.point(`projection_${stage}`));
    startupTrace?.point('persistence_ready');
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
