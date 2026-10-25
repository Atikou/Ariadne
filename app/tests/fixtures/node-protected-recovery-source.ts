import { lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute } from 'node:path';
import sharp from 'sharp';
import { AgentRunCommandService, digestAgentTurnInput, summarizeAgentTurnInput, digestAgentCommittedDirective,
  sha256AgentControlData, type AgentRunBinding, type AgentTurnInputSnapshotV1, type AgentRunCheckpointCommit } from '@ariadne/agent-core';
import { agentPersistenceKeyRingSchema } from '@ariadne/protocol/host';
import type { AgentPersistenceKeyRingStore } from '../../src/main/persistence/agent-persistence-keyring';
import { SqliteAgentRunUnitOfWork } from '../../../runtime/src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import { SqliteConversationRunHandoffUnitOfWork } from '../../../runtime/src/adapters/persistence/SqliteConversationRunHandoffUnitOfWork.js';
import { ConversationAuthorityService } from '../../../runtime/src/control/conversation/ConversationAuthorityService.js';
import { ConversationRunHandoffSagaService } from '../../../runtime/src/control/conversation/ConversationRunHandoffSagaService.js';
import { AesGcmAgentPersistencePayloadCodec } from '../../../runtime/src/adapters/persistence/AesGcmAgentPersistencePayloadCodec.js';
import { LocalConversationAttachmentStore } from '../../../runtime/src/adapters/attachment/LocalConversationAttachmentStore.js';
import { createShutdownContext } from '../../../runtime/src/ingress/ShutdownContext.js';
// Test-only Node owner, matching the production Core/Conversation host. Native
// Main sends OS-unsealed keys through private IPC; none are written or returned.
let phase = 'request', handled = false;
if (!process.send) throw new Error('fixture_private_ipc_required');
process.on('message', async (input: { dataRoot: string; keyRing: unknown; workspaceId: string }) => {
  if (handled) { process.exitCode=1; process.disconnect?.(); return; } handled=true;
  try {
    if (!isAbsolute(input.dataRoot) || !basename(dirname(input.dataRoot)).startsWith('AriadneDomainHealth-Protected-')
      || lstatSync(input.dataRoot).isSymbolicLink() || realpathSync.native(input.dataRoot) !== input.dataRoot) throw new Error('fixture_root_invalid');
    if (!/^workspace-[a-f0-9]{20}$/u.test(input.workspaceId)) throw new Error('fixture_workspace_invalid');
    await createProtectedCoreSource(input.dataRoot, agentPersistenceKeyRingSchema.parse(input.keyRing), input.workspaceId);
    process.send!({ok:true}, error => { if(error) process.exitCode=1; process.disconnect?.(); });
  } catch { process.exitCode=1; process.send!({ok:false,phase}, () => process.disconnect?.()); }
});

async function createProtectedCoreSource(dataRoot: string, ring: Awaited<ReturnType<AgentPersistenceKeyRingStore['loadForRuntime']>>, workspaceId: string): Promise<void> {
  phase = 'original-core-owners';
  const keys = ring.keys.map(value => ({ keyId: value.keyId, key: Buffer.from(value.keyMaterialBase64, 'base64') }));
  const codec = new AesGcmAgentPersistencePayloadCodec(ring.activeKeyId, keys);
  for (const value of keys) value.key.fill(0);
  const unit = new SqliteAgentRunUnitOfWork(dataRoot, codec), conversation = new SqliteConversationRunHandoffUnitOfWork(dataRoot);
  try {
    phase = 'original-core-conversation';
    const authority = new ConversationAuthorityService(conversation), at = (seconds: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString();
    await authority.createSession({ kind: 'conversation.create_session', commandId: 'native-create', eventId: 'native-created',
      sessionId: 'session-native', workspaceId, expectedVersion: null, occurredAt: at(0) });
    phase = 'original-core-image';
    const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4688bb' } }).png().toBuffer();
    const refs = await new LocalConversationAttachmentStore(dataRoot).saveImages([{ mediaType: 'image/png', data: image.toString('base64') }]);
    phase = 'original-core-message';
    const accepted = await authority.acceptUserMessage({ kind: 'conversation.accept_user_message', commandId: 'native-accept', eventId: 'native-accepted',
      sessionId: 'session-native', workspaceId, expectedSessionVersion: 1, messageId: 'message-native', expectedMessageVersion: null,
      content: 'Synthetic protected recovery input', attachments: refs, sagaId: 'saga-native', handoffCommandId: 'native-handoff',
      handoffOutboxMessageId: 'native-handoff-outbox', occurredAt: at(1) });
    const contentDigest = accepted.messageVersion.contentDigest, runId = 'run-native';
    const handoffs = new ConversationRunHandoffSagaService(conversation);
    const identity = { sagaId: accepted.saga.sagaId, sessionId: accepted.saga.sessionId, workspaceId: accepted.saga.workspaceId,
      messageId: accepted.saga.messageId, messageVersion: accepted.saga.messageVersion, objectiveDigest: accepted.saga.objectiveDigest };
    const requested = await handoffs.execute({ kind: 'handoff.request_agent_run', ...identity, commandId: 'native-run-request',
      expectedVersion: accepted.saga.version, inboxEventId: 'native-run-request-inbox', outboxMessageId: 'native-run-request-outbox',
      occurredAt: at(2), runRequestId: runId, agentCommandId: 'native-admit' });
    const binding: AgentRunBinding = { bindingVersion: 3, sessionId: 'session-native', objectiveRef: { kind: 'conversation_message', messageId: 'message-native', messageVersion: 1, contentDigest },
      workspace: { workspaceId, revision: 1, grantDigest: 'sha256:' + '2'.repeat(64), access: 'read', scopeIds: ['src'] },
      model: { providerId: 'provider-fixture', modelId: 'model-fixture', settingsRevision: 1 }, policy: { policyId: 'policy-fixture', revision: 1, permissionMode: 'trusted' },
      capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['src'] }], toolCatalog: { catalogId: 'catalog-fixture', revision: 1, digest: 'sha256:' + '3'.repeat(64), allowedToolNames: [] },
      budget: { grantId: 'grant-native', runId, vector: { modelTurns: 10, toolCalls: 0, readCalls: 0, writeCalls: 0, shellCalls: 0, costMicrousd: 1000000 },
        deadlineAt: '2031-01-01T00:00:00.000Z', source: { kind: 'root' } } };
    const cause = { kind: 'conversation_objective' as const, messageId: 'message-native', messageVersion: 1, contentDigest };
    const input: AgentTurnInputSnapshotV1 = { format: 'ariadne.agent-turn-input', schemaVersion: 1, runId, turnId: 'turn-native', cause,
      authorityRef: { kind: 'conversation_message', sessionId: 'session-native', workspaceId, messageId: 'message-native', messageVersion: 1, contentDigest },
      messages: [{ kind: 'text', role: 'user', content: 'Synthetic protected recovery input' }], availableTools: [] };
    const modelInput = { messages: input.messages, availableTools: input.availableTools };
    const digest = await digestAgentTurnInput(modelInput), commands = new AgentRunCommandService(unit);
    const checkpoint = (version: number, phase: string): AgentRunCheckpointCommit => ({ checkpointVersion: version, createdAt: at(version + 1),
      payload: { format: 'ariadne.agent-checkpoint', schemaVersion: 1, engineContinuation: { phase }, modelContext: [] } });
    phase = 'original-core-admit';
    await commands.execute({ kind: 'run.admit', commandId: 'native-admit', runId, occurredAt: at(2), binding,
      turn: { cause, turnId: 'turn-native', attemptId: 'attempt-native', providerIdempotencyKey: 'native-provider-key', inputDigest: digest, inputSummary: summarizeAgentTurnInput(modelInput) } },
    { checkpoint: checkpoint(1, 'admitted'), turnInputPayloads: [{ turnId: 'turn-native', inputDigest: digest, payload: input, recordedAt: at(2) }], effectPayloads: [] });
    phase = 'original-core-link';
    await handoffs.execute({ kind: 'handoff.link_agent_run', ...identity, commandId: 'native-run-link', expectedVersion: requested.saga.version,
      inboxEventId: 'native-run-link-inbox', outboxMessageId: 'native-run-link-outbox', occurredAt: at(2),
      runRequestId: runId, agentCommandId: 'native-admit', runId, admittedRunVersion: 1 });
    phase = 'original-core-start';
    await commands.execute({ kind: 'run.start_inference_attempt', commandId: 'native-start', runId, expectedVersion: 1, occurredAt: at(3), turnId: 'turn-native', attemptId: 'attempt-native' },
      { checkpoint: checkpoint(2, 'started'), turnInputPayloads: [], effectPayloads: [] });
    const response = 'SYNTHETIC_NATIVE_PROTECTED_RESPONSE', responseDigest = await sha256AgentControlData(response);
    const directive = { kind: 'respond' as const, contentRef: 'native-response-artifact', contentDigest: responseDigest }, directiveDigest = await digestAgentCommittedDirective(directive);
    phase = 'original-core-response';
    await commands.execute({ kind: 'run.record_inference_attempt_result', commandId: 'native-response', runId, expectedVersion: 2, occurredAt: at(4),
      turnId: 'turn-native', attemptId: 'attempt-native', result: { status: 'succeeded', directive, directiveDigest } },
    { checkpoint: checkpoint(3, 'completed'), turnInputPayloads: [], effectPayloads: [], directivePayloads: [{ artifactId: directive.contentRef,
      kind: 'response_content', directiveDigest, contentDigest: responseDigest, payload: response, recordedAt: at(4) }] });
    // The synthetic driver has already applied these three exact deliveries
    // through original commands. Acknowledge their original claimed outbox
    // identities; leave Core/result projection to the resumed real Runtime.
    phase = 'original-core-delivery';
    const delivered = await conversation.claimPending({ claimId: 'native-fixture-delivery', limit: 10, leaseMs: 30000 });
    const expected = new Set(['native-handoff-outbox', 'native-run-request-outbox', 'native-run-link-outbox']);
    if (delivered.length !== expected.size || delivered.some(value => !expected.has(value.message.messageId))) throw new Error('fixture_delivery_identity_changed');
    await conversation.acknowledgePublished({ claimId: 'native-fixture-delivery', messages: delivered.map(value => ({ cursor: value.cursor, messageId: value.message.messageId })) });
    phase = 'original-core-resume';
  } finally { const shutdown = createShutdownContext(Date.now() + 5000);
    try { await conversation.close(shutdown); await unit.close(shutdown); } finally { shutdown.dispose(); codec.destroy(); }
  }
}
