import type { SqliteAgentRunUnitOfWork } from '../../../../adapters/persistence/SqliteAgentRunUnitOfWork.js';
import type { SqliteConversationRunHandoffUnitOfWork } from '../../../../adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import type { SqlitePublicProjectionStore } from '../../../../adapters/persistence/SqlitePublicProjectionStore.js';
import type { SqliteProductivityStore } from '../../../../adapters/persistence/SqliteProductivityStore.js';
import type { SqliteTaskQuerySnapshotStore } from '../../../../adapters/persistence/SqliteTaskQuerySnapshotStore.js';
import type { LocalConversationAttachmentStore } from '../../../../adapters/attachment/LocalConversationAttachmentStore.js';
import type { FileAgentSubagentSessionStore } from '../../../../adapters/subagent/FileAgentSubagentSessionStore.js';
import type { ShutdownContext } from '../../../../ingress/ShutdownContext.js';

export interface AgentPersistenceComponentHandle {
  readonly unitOfWork: SqliteAgentRunUnitOfWork;
  readonly conversation: SqliteConversationRunHandoffUnitOfWork;
  readonly publicProjection: SqlitePublicProjectionStore;
  readonly taskQuerySnapshots?: SqliteTaskQuerySnapshotStore;
  readonly productivity?: SqliteProductivityStore;
  readonly attachmentStore: LocalConversationAttachmentStore;
  readonly subagentSessionStore: FileAgentSubagentSessionStore;
  prepareShutdown(context: ShutdownContext): void;
  close(context: ShutdownContext): Promise<void>;
  rollback(context: ShutdownContext): Promise<readonly unknown[]>;
}
