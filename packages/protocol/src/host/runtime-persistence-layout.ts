/** Private Main/Runtime storage layout. These paths never grant Renderer file access. */
export const RUNTIME_DATABASE_PATHS = Object.freeze({
  agentControl: 'data/agent-control/agent-control.db',
  conversation: 'data/conversation/conversation.db',
  publicProjection: 'data/public-projection/projection.db',
  runtimeCommand: 'data/runtime-control/runtime-command.db',
  productivity: 'data/productivity/productivity.db',
  modelCapability: 'data/model-capability/model-capability.db',
  longMemory: 'data/long-memory/long-memory.db'
});
/** Disposable indexes have separate ownership and never enter backup authority. */
export const RUNTIME_DERIVED_DATABASE_PATHS = Object.freeze({ taskQuery: 'data/task-query/snapshots.db' });

/** LocalConversationAttachmentStore stages only sha256.randomUUID().tmp in
 * that digest's bucket. Unknown names never establish disposable ownership. */
export function isUnpublishedConversationAttachmentObjectName(name: string, bucket: string): boolean {
  return /^[a-f0-9]{2}$/u.test(bucket) && name.startsWith(bucket)
    && /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u.test(name);
}
