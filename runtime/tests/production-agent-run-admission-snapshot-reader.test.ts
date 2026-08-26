import { createHash } from 'node:crypto';

import type {
  AgentRunCheckpointReference,
  AgentEffectPayloadReference,
  AgentRunTransaction
} from '@ariadne/agent-core';
import { describe, expect, it } from 'vitest';

import { ImmutableAgentToolCatalog } from '../src/adapters/tool/ImmutableAgentToolCatalog.js';
import {
  compileTrustedAgentToolCatalog,
  type TrustedAgentToolCatalogSnapshot,
  type TrustedAgentToolRegistrationV1
} from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import {
  ProductionAgentRunAdmissionSnapshotReader
} from '../src/composition/ProductionAgentRunAdmissionSnapshotReader.js';
import {
  digestConversationMessageContent,
  type ConversationMessageHead,
  type ConversationMessageVersion,
  type ConversationSession
} from '../src/conversation/ConversationAuthority.js';
import {
  fingerprintConversationRunHandoffCommand,
  transitionConversationRunHandoff,
  type ConversationRunHandoffCommand,
  type ConversationRunHandoffSaga
} from '../src/conversation/ConversationRunHandoffSaga.js';
import {
  createAgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundle,
  type AgentAdmissionAuthorityBundleProvider,
  type AgentAdmissionAuthorityQueryV2,
  type AgentAdmissionToolCatalogProvider,
  type AgentAdmissionToolCatalogReferenceV1
} from '../src/control/ports/AgentAdmissionAuthority.js';
import type {
  AcceptConversationUserMessageCommit,
  ConversationAuthorityTransaction,
  ConversationAuthorityUnitOfWork,
  CreateConversationSessionCommit,
  ProjectConversationAgentResultCommit
} from '../src/control/ports/ConversationAuthorityPersistence.js';
import type {
  ConversationRunHandoffCommit
} from '../src/control/ports/ConversationRunHandoffPersistence.js';
import {
  AgentRunAdmissionController,
  deriveAgentAdmissionCommandId,
  deriveAgentAdmissionRunId,
  type AgentRunAdmissionStore,
  type AgentRunRequestedHandoffMessage
} from '../src/control/run/AgentRunAdmissionController.js';
import type {
  AgentToolContractDocumentV1,
  AgentToolExecutableImplementationV1
} from '../src/control/ports/AgentToolExecution.js';

const ACCEPTED_AT = '2030-01-01T00:00:00.000Z';
const REQUESTED_AT = '2030-01-01T00:00:01.000Z';
const OBJECTIVE = 'protected exact production objective';

describe('ProductionAgentRunAdmissionSnapshotReader', () => {
  it('builds one version-pinned v3 snapshot from explicit authorities and a strict Tool intersection', async () => {
    const fixture = await createFixture();
    const catalogSnapshot = compiledCatalog();
    const catalog = new ImmutableAgentToolCatalog(catalogSnapshot);
    const bundle = await authorityBundle(fixture.request, catalogSnapshot);
    let authorityQuery: AgentAdmissionAuthorityQueryV2 | undefined;
    let catalogReference: AgentAdmissionToolCatalogReferenceV1 | undefined;
    const reader = new ProductionAgentRunAdmissionSnapshotReader(
      fixture.conversation,
      provider(async (query) => {
        authorityQuery = query;
        return bundle;
      }),
      catalogProvider(async (reference) => {
        catalogReference = reference;
        return catalog;
      })
    );

    const snapshot = await reader.readAdmissionSnapshot(
      fixture.request,
      new AbortController().signal
    );
    const runId = await deriveAgentAdmissionRunId(fixture.request);

    expect(fixture.conversation.transactions).toBe(1);
    expect(fixture.conversation.objectiveReadInsideTransaction).toBe(true);
    expect(authorityQuery).toEqual({
      queryVersion: 2,
      subjectVersion: 2,
      sessionId: fixture.request.sessionId,
      workspaceId: fixture.request.workspaceId,
      objectiveMessageId: fixture.request.objectiveMessageId,
      objectiveMessageVersion: fixture.request.objectiveMessageVersion,
      objectiveDigest: fixture.request.objectiveDigest,
      runId,
      execution: { mode: 'agent' }
    });
    expect(catalogReference).toEqual({
      referenceVersion: 1,
      catalogId: catalogSnapshot.catalogId,
      revision: 23,
      digest: catalogSnapshot.catalogDigest
    });
    expect(snapshot).toMatchObject({
      sessionId: fixture.request.sessionId,
      workspaceId: fixture.request.workspaceId,
      messageId: fixture.request.objectiveMessageId,
      messageVersion: 1,
      objectiveDigest: fixture.request.objectiveDigest,
      binding: {
        bindingVersion: 4,
        executionProfile: { mode: 'agent' },
        workspace: { revision: 7, scopeIds: ['workspace.root'] },
        model: { settingsRevision: 11 },
        policy: { revision: 13 },
        capabilities: [{
          capabilityId: 'workspace.read',
          scopeIds: ['workspace.root']
        }],
        toolCatalog: {
          revision: 23,
          allowedToolNames: ['workspace.read']
        },
        budget: {
          runId,
          vector: { modelTurns: 12, readCalls: 8 },
          source: { kind: 'root' }
        }
      },
      input: {
        messages: [{ kind: 'text', role: 'user', content: OBJECTIVE }],
        availableTools: [{
          tool: { toolName: 'workspace.read', revision: 23 },
          capabilityIds: ['workspace.read']
        }]
      }
    });
    expect(snapshot.input.availableTools).toHaveLength(1);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.capabilityGrant.capabilities)).toBe(true);
    expect(Object.isFrozen(bundle.rootBudget.vector)).toBe(true);
    expect(bundle).toMatchObject({
      revision: 29,
      capabilityGrant: { revision: 17 },
      rootBudget: { revision: 19 }
    });
  });

  it('injects the exact authoritative Conversation history through the objective', async () => {
    const fixture = await createFixture({
      priorMessages: [
        { role: 'user', content: 'earlier user request' },
        { role: 'assistant', content: 'earlier assistant result' }
      ]
    });
    const catalogSnapshot = compiledCatalog();
    const bundle = await authorityBundle(fixture.request, catalogSnapshot);
    const snapshot = await readerWith(
      fixture.conversation,
      provider(async () => bundle),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot))
    ).readAdmissionSnapshot(fixture.request, new AbortController().signal);

    expect(snapshot.input.messages).toEqual([
      { kind: 'text', role: 'user', content: 'earlier user request' },
      { kind: 'text', role: 'assistant', content: 'earlier assistant result' },
      { kind: 'text', role: 'user', content: OBJECTIVE }
    ]);
  });

  it('materializes the exact read-only plan authority without a second Tool filter', async () => {
    const fixture = await createFixture({
      execution: {
        mode: 'plan',
        modelId: 'model-production',
        routingStrategy: 'quality-first'
      }
    });
    const catalogSnapshot = compileTrustedAgentToolCatalog({
      catalogId: 'catalog-plan',
      revision: 24,
      tools: [
        registration('workspace.list_files', 'workspace.read', 'read'),
        registration('workspace.read_file', 'workspace.read', 'read'),
        registration('workspace.write_file', 'workspace.write', 'write')
      ]
    });
    const bundle = await authorityBundle(fixture.request, catalogSnapshot, {
      workspaceAccess: 'read',
      capabilities: [{
        capabilityId: 'workspace.read',
        scopeIds: ['workspace.root']
      }],
      executionMode: 'plan',
      allowedToolNames: [
        'workspace.list_files',
        'workspace.read_file'
      ]
    });
    let authorityQuery: AgentAdmissionAuthorityQueryV2 | undefined;
    const snapshot = await readerWith(
      fixture.conversation,
      provider(async (query) => {
        authorityQuery = query;
        return bundle;
      }),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot))
    ).readAdmissionSnapshot(fixture.request, new AbortController().signal);

    expect(authorityQuery?.execution).toEqual({
      mode: 'plan',
      modelId: 'model-production',
      routingStrategy: 'quality-first'
    });
    expect(snapshot.input.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Plan mode is read-only')
      }),
      { kind: 'text', role: 'user', content: OBJECTIVE }
    ]);
    expect(snapshot.input.availableTools.map((tool) => tool.tool.toolName)).toEqual([
      'workspace.list_files',
      'workspace.read_file'
    ]);
    expect(snapshot.binding).toMatchObject({
      workspace: { access: 'read' },
      capabilities: [{ capabilityId: 'workspace.read' }],
      toolCatalog: {
        allowedToolNames: ['workspace.list_files', 'workspace.read_file']
      }
    });
  });

  it('places bounded Workspace and Skill instructions before the objective', async () => {
    const fixture = await createFixture();
    const catalogSnapshot = compiledCatalog();
    const bundle = await authorityBundle(fixture.request, catalogSnapshot);
    const reader = new ProductionAgentRunAdmissionSnapshotReader(
      fixture.conversation,
      provider(async () => bundle),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot)),
      { resolve: () => '[INSTRUCTION authority=skill source=user:review]\nReview first.\n[/INSTRUCTION]' }
    );
    const snapshot = await reader.readAdmissionSnapshot(
      fixture.request,
      new AbortController().signal
    );
    expect(snapshot.input.messages).toEqual([
      {
        kind: 'text',
        role: 'system',
        content: '[INSTRUCTION authority=skill source=user:review]\nReview first.\n[/INSTRUCTION]'
      },
      { kind: 'text', role: 'user', content: OBJECTIVE }
    ]);
  });

  it('fails closed before the Agent write when configured instructions are invalid', async () => {
    const fixture = await createFixture();
    const catalogSnapshot = compiledCatalog();
    const bundle = await authorityBundle(fixture.request, catalogSnapshot);
    const reader = new ProductionAgentRunAdmissionSnapshotReader(
      fixture.conversation,
      provider(async () => bundle),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot)),
      { resolve: () => { throw new Error('skill_not_found:missing'); } }
    );
    await expect(reader.readAdmissionSnapshot(
      fixture.request,
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'AGENT_ADMISSION_INSTRUCTIONS_INVALID' });
  });

  it('rejects empty authority scopes and copied or partial bundles', async () => {
    const fixture = await createFixture();
    const catalogSnapshot = compiledCatalog();
    const valid = await authorityBundle(fixture.request, catalogSnapshot);
    await expect(authorityBundle(fixture.request, catalogSnapshot, {
      workspaceScopeIds: []
    })).rejects.toThrow('cannot be empty');
    const partial = { ...valid } as Record<string, unknown>;
    delete partial.model;
    expect(() => createAgentAdmissionAuthorityBundle(
      partial as unknown as Parameters<typeof createAgentAdmissionAuthorityBundle>[0]
    )).toThrow('unexpected');
    const accessorBacked = structuredClone(valid);
    Object.defineProperty(accessorBacked.workspace.scopeIds, '0', {
      enumerable: true,
      configurable: true,
      get: () => 'workspace.root'
    });
    expect(() => createAgentAdmissionAuthorityBundle(accessorBacked))
      .toThrow('dense data-only');

    const copied = structuredClone(valid) as AgentAdmissionAuthorityBundle;
    const reader = readerWith(
      fixture.conversation,
      provider(async () => copied),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot))
    );
    await expect(reader.readAdmissionSnapshot(
      fixture.request,
      new AbortController().signal
    )).rejects.toMatchObject({ code: 'AGENT_ADMISSION_AUTHORITY_INVALID' });
  });

  it('keeps an old exact Handoff stable when the Session authority advances', async () => {
    const fixture = await createFixture({ currentSessionVersion: 9 });
    const catalogSnapshot = compiledCatalog();
    const bundle = await authorityBundle(fixture.request, catalogSnapshot);
    const snapshot = await readerWith(
      fixture.conversation,
      provider(async () => bundle),
      catalogProvider(async () => new ImmutableAgentToolCatalog(catalogSnapshot))
    ).readAdmissionSnapshot(fixture.request, new AbortController().signal);

    expect(snapshot).toMatchObject({
      sessionId: fixture.request.sessionId,
      messageId: fixture.request.objectiveMessageId,
      messageVersion: fixture.request.objectiveMessageVersion,
      objectiveDigest: fixture.request.objectiveDigest,
      input: { messages: [{ kind: 'text', role: 'user', content: OBJECTIVE }] }
    });
    expect(fixture.conversation.transactions).toBe(1);
    expect(fixture.conversation.objectiveReadInsideTransaction).toBe(true);
  });

  it.each([
    'message_head_drift',
    'message_role_drift',
    'missing_bundle',
    'partial_bundle',
    'bundle_subject_drift',
    'missing_catalog',
    'catalog_identity_drift'
  ] as const)('fails closed on %s before the first Agent write', async (failure) => {
    const fixture = await createFixture({
      headLatestVersion: failure === 'message_head_drift' ? 2 : 1,
      messageRole: failure === 'message_role_drift' ? 'assistant' : 'user'
    });
    const catalogSnapshot = compiledCatalog();
    const exactBundle = await authorityBundle(fixture.request, catalogSnapshot);
    const driftedBundle = await authorityBundle(fixture.request, catalogSnapshot, {
      objectiveDigest: `sha256:${'f'.repeat(64)}`
    });
    const partialBundle = { ...exactBundle } as Record<string, unknown>;
    delete partialBundle.policy;
    const wrongCatalog = new ImmutableAgentToolCatalog(compileTrustedAgentToolCatalog({
      catalogId: 'catalog-drifted',
      revision: 23,
      tools: [registration('workspace.read', 'workspace.read', 'read')]
    }));
    const authority = provider(async () => (
      failure === 'missing_bundle'
        ? null
        : failure === 'partial_bundle'
          ? partialBundle as unknown as AgentAdmissionAuthorityBundle
        : failure === 'bundle_subject_drift'
          ? driftedBundle
          : exactBundle
    ));
    const catalogs = catalogProvider(async () => (
      failure === 'missing_catalog'
        ? null
        : failure === 'catalog_identity_drift'
          ? wrongCatalog
          : new ImmutableAgentToolCatalog(catalogSnapshot)
    ));
    const store = new NoWriteAdmissionStore();
    const controller = new AgentRunAdmissionController(
      store,
      readerWith(fixture.conversation, authority, catalogs)
    );

    await expect(controller.admit(fixture.request)).rejects.toBeInstanceOf(Error);
    expect(store.writeTransactions).toBe(0);
  });
});

interface FixtureOptions {
  readonly headLatestVersion?: number;
  readonly messageRole?: 'user' | 'assistant';
  readonly currentSessionVersion?: number;
  readonly execution?: ConversationMessageVersion['payload']['execution'];
  readonly priorMessages?: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }[];
}

interface Fixture {
  readonly request: AgentRunRequestedHandoffMessage;
  readonly conversation: StaticConversationAuthorityUnitOfWork;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const objectiveDigest = await digestConversationMessageContent(OBJECTIVE);
  const runRequestId = 'run-request-production';
  const commandIdentity = {
    sagaId: 'saga-production',
    runRequestId,
    sessionId: 'session-production',
    workspaceId: 'workspace-production',
    objectiveMessageId: 'message-production',
    objectiveMessageVersion: 1,
    objectiveDigest
  };
  const agentCommandId = await deriveAgentAdmissionCommandId(commandIdentity);
  const acceptedCommand: Extract<
    ConversationRunHandoffCommand,
    { readonly kind: 'handoff.accept_message' }
  > = {
    kind: 'handoff.accept_message',
    sagaId: commandIdentity.sagaId,
    commandId: 'handoff-accept-production',
    expectedVersion: null,
    inboxEventId: 'handoff-accept-inbox-production',
    outboxMessageId: 'handoff-accept-outbox-production',
    occurredAt: ACCEPTED_AT,
    sessionId: commandIdentity.sessionId,
    workspaceId: commandIdentity.workspaceId,
    messageId: commandIdentity.objectiveMessageId,
    messageVersion: commandIdentity.objectiveMessageVersion,
    objectiveDigest
  };
  const accepted = transitionConversationRunHandoff(
    null,
    acceptedCommand,
    await fingerprintConversationRunHandoffCommand(acceptedCommand)
  );
  const requestCommand: Extract<
    ConversationRunHandoffCommand,
    { readonly kind: 'handoff.request_agent_run' }
  > = {
    kind: 'handoff.request_agent_run',
    sagaId: commandIdentity.sagaId,
    commandId: 'handoff-request-production',
    expectedVersion: 1,
    inboxEventId: 'handoff-request-inbox-production',
    outboxMessageId: 'handoff-request-outbox-production',
    occurredAt: REQUESTED_AT,
    sessionId: commandIdentity.sessionId,
    workspaceId: commandIdentity.workspaceId,
    messageId: commandIdentity.objectiveMessageId,
    messageVersion: commandIdentity.objectiveMessageVersion,
    objectiveDigest,
    runRequestId,
    agentCommandId
  };
  const requested = transitionConversationRunHandoff(
    accepted.saga,
    requestCommand,
    await fingerprintConversationRunHandoffCommand(requestCommand)
  );
  if (requested.outbox.kind !== 'agent.run.requested') {
    throw new Error('requested_outbox_missing');
  }
  const session: ConversationSession = {
    sessionId: commandIdentity.sessionId,
    workspaceId: commandIdentity.workspaceId,
    version: options.currentSessionVersion ?? 2,
    createdAt: ACCEPTED_AT,
    updatedAt: ACCEPTED_AT
  };
  const head: ConversationMessageHead = {
    messageId: commandIdentity.objectiveMessageId,
    sessionId: commandIdentity.sessionId,
    workspaceId: commandIdentity.workspaceId,
    latestVersion: options.headLatestVersion ?? 1,
    createdAt: ACCEPTED_AT,
    updatedAt: ACCEPTED_AT
  };
  const message: ConversationMessageVersion = {
    messageId: commandIdentity.objectiveMessageId,
    version: 1,
    sessionId: commandIdentity.sessionId,
    workspaceId: commandIdentity.workspaceId,
    role: options.messageRole ?? 'user',
    payload: {
      content: OBJECTIVE,
      ...(options.execution === undefined
        ? {}
        : { execution: structuredClone(options.execution) })
    },
    contentDigest: objectiveDigest,
    createdAt: ACCEPTED_AT
  };
  const history: ConversationMessageVersion[] = [];
  for (const [index, prior] of (options.priorMessages ?? []).entries()) {
    history.push({
      messageId: `message-prior-${String(index)}`,
      version: 1,
      sessionId: commandIdentity.sessionId,
      workspaceId: commandIdentity.workspaceId,
      role: prior.role,
      payload: { content: prior.content },
      contentDigest: await digestConversationMessageContent(prior.content),
      createdAt: new Date(Date.parse(ACCEPTED_AT) - (options.priorMessages!.length - index) * 1_000)
        .toISOString()
    });
  }
  history.push(message);
  return {
    request: requested.outbox,
    conversation: new StaticConversationAuthorityUnitOfWork(
      session,
      head,
      message,
      requested.saga,
      history
    )
  };
}

interface BundleOverrides {
  readonly workspaceScopeIds?: readonly string[];
  readonly objectiveDigest?: string;
  readonly workspaceAccess?: 'read' | 'write';
  readonly capabilities?: AgentAdmissionAuthorityBundle['capabilityGrant']['capabilities'];
  readonly allowedToolNames?: readonly string[];
  readonly executionMode?: 'agent' | 'plan';
}

async function authorityBundle(
  request: AgentRunRequestedHandoffMessage,
  catalog: TrustedAgentToolCatalogSnapshot,
  overrides: BundleOverrides = {}
): Promise<AgentAdmissionAuthorityBundle> {
  const runId = await deriveAgentAdmissionRunId(request);
  const objectiveDigest = overrides.objectiveDigest ?? request.objectiveDigest;
  return createAgentAdmissionAuthorityBundle({
    authorityBundleVersion: 2,
    bundleId: 'admission-authority-production',
    revision: 29,
    subject: {
      subjectVersion: 2,
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      objectiveMessageId: request.objectiveMessageId,
      objectiveMessageVersion: request.objectiveMessageVersion,
      objectiveDigest,
      runId,
      executionProfile: { mode: overrides.executionMode ?? 'agent' }
    },
    workspace: {
      workspaceId: request.workspaceId,
      revision: 7,
      grantDigest: `sha256:${'a'.repeat(64)}`,
      access: overrides.workspaceAccess ?? 'read',
      scopeIds: overrides.workspaceScopeIds ?? ['workspace.root']
    },
    model: {
      providerId: 'provider-production',
      modelId: 'model-production',
      settingsRevision: 11
    },
    policy: {
      policyId: 'policy-production',
      revision: 13,
      permissionMode: 'ask'
    },
    capabilityGrant: {
      grantId: 'capability-grant-production',
      revision: 17,
      capabilities: overrides.capabilities ?? [{
        capabilityId: 'workspace.read',
        scopeIds: ['workspace.root']
      }]
    },
    toolCatalog: {
      catalogId: catalog.catalogId,
      revision: catalog.revision,
      digest: catalog.catalogDigest,
      allowedToolNames: overrides.allowedToolNames ?? ['workspace.read']
    },
    rootBudget: {
      authorityId: 'root-budget-authority-production',
      revision: 19,
      grantId: 'root-budget-grant-production',
      runId,
      vector: {
        modelTurns: 12,
        toolCalls: 8,
        readCalls: 8,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 1_000_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z'
    }
  });
}

function readerWith(
  conversation: ConversationAuthorityUnitOfWork,
  authority: AgentAdmissionAuthorityBundleProvider,
  catalogs: AgentAdmissionToolCatalogProvider
): ProductionAgentRunAdmissionSnapshotReader {
  return new ProductionAgentRunAdmissionSnapshotReader(
    conversation,
    authority,
    catalogs
  );
}

function provider(
  read: AgentAdmissionAuthorityBundleProvider['readAuthorityBundle']
): AgentAdmissionAuthorityBundleProvider {
  return { readAuthorityBundle: read };
}

function catalogProvider(
  read: AgentAdmissionToolCatalogProvider['readToolCatalog']
): AgentAdmissionToolCatalogProvider {
  return { readToolCatalog: read };
}

class StaticConversationAuthorityUnitOfWork
implements ConversationAuthorityUnitOfWork {
  public transactions = 0;
  public objectiveReadInsideTransaction = false;
  private active = false;

  public constructor(
    private readonly session: ConversationSession,
    private readonly head: ConversationMessageHead,
    private readonly message: ConversationMessageVersion,
    private readonly saga: ConversationRunHandoffSaga,
    private readonly history: readonly ConversationMessageVersion[] = [message]
  ) {}

  public async authorityTransaction<T>(
    operation: (transaction: ConversationAuthorityTransaction) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    this.active = true;
    const transaction: ConversationAuthorityTransaction = {
      loadSession: async () => this.session,
      loadSaga: async () => this.saga,
      loadMessageHead: async () => this.head,
      loadMessageVersion: async () => {
        this.objectiveReadInsideTransaction = this.active;
        return this.message;
      },
      loadSessionMessageHistoryThrough: async () => this.history,
      loadCommittedAuthorityCommand: async () => null,
      loadCommittedCommand: async () => null,
      commitCreatedSession: forbiddenWrite,
      commitAcceptedUserMessage: forbiddenWrite,
      commitProjectedAgentResult: forbiddenWrite,
      commit: forbiddenWrite
    };
    try {
      return await operation(transaction);
    } finally {
      this.active = false;
    }
  }
}

async function forbiddenWrite(
  _commit:
    | CreateConversationSessionCommit
    | AcceptConversationUserMessageCommit
    | ProjectConversationAgentResultCommit
    | ConversationRunHandoffCommit
): Promise<void> {
  throw new Error('unexpected_conversation_write');
}

class NoWriteAdmissionStore implements AgentRunAdmissionStore {
  public writeTransactions = 0;

  public async transaction<T>(
    _operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    this.writeTransactions += 1;
    throw new Error('unexpected_agent_write');
  }

  public async loadCommittedCommandReceipt(): Promise<null> {
    return null;
  }

  public async loadCheckpoint(_reference: AgentRunCheckpointReference): Promise<never> {
    throw new Error('unexpected_checkpoint_read');
  }

  public async loadEffectInput(_reference: AgentEffectPayloadReference): Promise<never> {
    throw new Error('unexpected_effect_input_read');
  }

  public async loadEffectResult(
    _reference: AgentEffectPayloadReference & { readonly hasResult: true }
  ): Promise<never> {
    throw new Error('unexpected_effect_result_read');
  }
}

function compiledCatalog(): TrustedAgentToolCatalogSnapshot {
  return compileTrustedAgentToolCatalog({
    catalogId: 'catalog-production',
    revision: 23,
    tools: [
      registration('workspace.read', 'workspace.read', 'read'),
      registration('workspace.write', 'workspace.write', 'write')
    ]
  });
}

function registration(
  toolName: string,
  capabilityId: string,
  access: 'read' | 'write'
): TrustedAgentToolRegistrationV1 {
  const artifacts = artifactBytes(toolName);
  const document: AgentToolContractDocumentV1 = {
    documentVersion: 1,
    toolName,
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capabilityIds: [capabilityId],
    requiredWorkspaceAccess: access,
    permission: { authority: 'run_grant', approval: 'never' },
    scopeSemantics: 'all_requested_workspace_scopes_must_be_granted',
    resourceSemantics: 'workspace_relative_path',
    lifecycleSemantics: 'bounded_invocation',
    sideEffect: access,
    idempotency: access === 'write'
      ? 'idempotency_key_required'
      : 'not_idempotent',
    recovery: access === 'write' ? 'retry_same_idempotency_key' : 'none',
    timeoutMs: 30_000,
    implementationArtifacts: {
      providerDigest: digest(artifacts.provider),
      normalizerDigest: digest(artifacts.normalizer),
      preparedValidatorDigest: digest(artifacts.preparedValidator),
      executeDigest: digest(artifacts.execute)
    }
  };
  return {
    document,
    executable: {
      artifacts,
      normalizeAndValidate: (input) => ({ status: 'accepted', input }),
      validatePrepared: (input) => ({ status: 'accepted', input }),
      execute: async () => ({ status: 'succeeded' })
    }
  };
}

function artifactBytes(
  seed: string
): AgentToolExecutableImplementationV1['artifacts'] {
  return {
    provider: new TextEncoder().encode(`${seed}:provider`),
    normalizer: new TextEncoder().encode(`${seed}:normalizer`),
    preparedValidator: new TextEncoder().encode(`${seed}:prepared`),
    execute: new TextEncoder().encode(`${seed}:execute`)
  };
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
