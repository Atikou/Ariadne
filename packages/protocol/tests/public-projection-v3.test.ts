import { describe, expect, it } from 'vitest';

import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  PUBLIC_PROJECTION_GENESIS_DIGEST,
  assertPublicProjectionCommitV3,
  assertPublicProjectionReadBatchV3,
  assertPublicProjectionSnapshotV3,
  projectionCommitV3Schema,
  publicDecisionActionTokenV1,
  publicDecisionProjectionV3Schema,
  publicAgentInboxInputV3Schema,
  publicMessageProjectionV3Schema,
  publicProjectionCanonicalTimestampSchema,
  publicProjectionReadBatchV3Schema,
  publicRunProjectionV3Schema,
  publicProjectionSnapshotV3Schema,
  redactPublicProjectionTextV3,
  runtimeCommandSchema,
  runtimeResultSchema,
  runtimeSnapshotSchema
} from '../src/public.js';

const TIME = '2032-01-01T00:00:00.000Z';

describe('public projection contract v3', () => {
  it('accepts only bounded public-static Tool presentation metadata', () => {
    const run = {
      runId: 'run-tool-presentation',
      sessionId: 'session-tool-presentation',
      sourceMessageId: 'message-tool-presentation',
      version: 2,
      title: 'Agent run',
      status: 'running',
      label: 'Running Tool',
      toolActivities: [{
        activityId: 'effect-tool-presentation',
        callId: 'call-tool-presentation',
        toolName: 'workspace.write_file',
        presentation: {
          kind: 'file_change',
          label: '写入工作区文件'
        },
        status: 'running',
        occurredAt: TIME,
        startedAt: TIME
      }],
      inbox: [],
      interactionMessages: [],
      updatedAt: TIME,
      startedAt: TIME
    } as const;

    expect(publicRunProjectionV3Schema.parse(run).toolActivities[0]?.presentation)
      .toEqual({ kind: 'file_change', label: '写入工作区文件' });
    expect(publicRunProjectionV3Schema.safeParse({
      ...run,
      toolActivities: [{
        ...run.toolActivities[0],
        presentation: {
          ...run.toolActivities[0].presentation,
          resultVisibility: 'protected'
        }
      }]
    }).success).toBe(false);
  });

  it('binds every projected Child Run to one visible execution provider', () => {
    const child = {
      runId: 'run-child-provider',
      sessionId: 'session-provider',
      parentRunId: 'run-parent-provider',
      delegationId: 'delegation-provider',
      subagentMode: 'continuable',
      subagentProviderId: 'external.codex',
      version: 3,
      title: 'SubAgent task',
      status: 'paused',
      label: 'Waiting for continuation input',
      toolActivities: [],
      inbox: [],
      interactionMessages: [],
      updatedAt: TIME
    } as const;
    expect(publicRunProjectionV3Schema.parse(child).subagentProviderId)
      .toBe('external.codex');
    const { subagentProviderId: _providerId, ...missingProvider } = child;
    expect(publicRunProjectionV3Schema.safeParse(missingProvider).success).toBe(false);
  });

  it('distinguishes system live-work completion from editable user inbox input', () => {
    expect(publicAgentInboxInputV3Schema.parse({
      inputId: 'input-live-work',
      messageId: 'message-live-work',
      version: 1,
      delivery: 'next_step',
      content: 'Background job completed.',
      source: {
        kind: 'live_work',
        jobId: 'job-live-work',
        workKind: 'process',
        status: 'completed'
      },
      state: 'queued',
      queuedAt: TIME,
      updatedAt: TIME
    }).source).toEqual({
      kind: 'live_work',
      jobId: 'job-live-work',
      workKind: 'process',
      status: 'completed'
    });
    expect(publicAgentInboxInputV3Schema.parse({
      inputId: 'input-user-question-answer',
      messageId: 'message-user-question-answer',
      version: 1,
      delivery: 'next_step',
      content: 'local: Local only',
      source: {
        kind: 'user_question_answer',
        decisionId: 'decision-user-question',
        questionDigest: `sha256:${'a'.repeat(64)}`
      },
      state: 'queued',
      queuedAt: TIME,
      updatedAt: TIME
    }).source).toMatchObject({
      kind: 'user_question_answer',
      decisionId: 'decision-user-question'
    });
  });

  it('redacts private substrings before intentionally public text is committed', () => {
    const redacted = redactPublicProjectionTextV3(
      'inspect C:\\private\\repo and /srv/private; api_key=topsecretvalue'
    );
    expect(redacted).toContain('[redacted path]');
    expect(redacted).toContain('[redacted credential]');
    expect(redacted).not.toContain('C:\\private');
    expect(redacted).not.toContain('/srv/private');
    expect(() => assertPublicProjectionCommitV3({
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      eventId: 'event-redacted-message',
      sourceId: 'source-redacted-message',
      sourceCursor: 1,
      occurredAt: TIME,
      changes: [{
        feature: 'messages',
        operation: 'upsert',
        aggregateId: 'message-redacted',
        aggregateVersion: 1,
        projectedAt: TIME,
        dto: {
          messageId: 'message-redacted',
          sessionId: 'session-redacted',
          version: 1,
          role: 'user',
          content: redacted,
          status: 'completed',
          createdAt: TIME,
          updatedAt: TIME
        }
      }]
    })).not.toThrow();
  });

  it('exposes only versioned Snapshot and digest-bound replay query shapes', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'projection.snapshot.get',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
    })).toEqual({
      kind: 'projection.snapshot.get',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION
    });
    expect(runtimeCommandSchema.safeParse({
      kind: 'projection.snapshot.get',
      contractVersion: '2.0'
    }).success).toBe(false);

    const snapshot = sessionSnapshot('Session');
    expect(runtimeResultSchema.parse({
      kind: 'projection.snapshot',
      snapshot
    })).toEqual({ kind: 'projection.snapshot', snapshot });

    const request = {
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: snapshot.streamId,
      afterCursor: snapshot.cursor,
      afterDigest: snapshot.cursorDigest,
      limit: 200
    } as const;
    expect(runtimeCommandSchema.parse({
      kind: 'projection.commits.read',
      request
    })).toEqual({ kind: 'projection.commits.read', request });
    expect(runtimeCommandSchema.safeParse({
      kind: 'projection.commits.read',
      request: { ...request, afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST }
    }).success).toBe(false);
  });

  it('defines versioned Conversation authority mutations without hidden defaults', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.session.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3'
    })).toMatchObject({ kind: 'conversation.session.create.v3' });
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.session.rename.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 1,
      title: 'Durable title'
    })).toMatchObject({ kind: 'conversation.session.rename.v3' });
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.session.archive.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 2
    })).toMatchObject({ kind: 'conversation.session.archive.v3' });
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.session.restore.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 3
    })).toMatchObject({ kind: 'conversation.session.restore.v3' });
    expect(runtimeCommandSchema.safeParse({
      kind: 'conversation.session.rename.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 1,
      title: '   '
    }).success).toBe(false);
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.message.accept.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 1,
      messageId: 'message-v3',
      content: 'hello'
    })).toMatchObject({ kind: 'conversation.message.accept.v3' });
    expect(runtimeCommandSchema.safeParse({
      kind: 'conversation.message.accept.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      messageId: 'message-v3',
      content: 'hello'
    }).success).toBe(false);
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.message.accept.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 1,
      messageId: 'message-image-v3',
      content: '',
      attachments: [{
        mediaType: 'image/png',
        data: 'aGVsbG8=',
        name: 'screen.png'
      }]
    })).toMatchObject({ kind: 'conversation.message.accept.v3', content: '' });
    expect(runtimeCommandSchema.safeParse({
      kind: 'conversation.message.accept.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      expectedSessionVersion: 1,
      messageId: 'message-empty-v3',
      content: '   '
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      kind: 'conversation.session.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      sessionId: 'session-v3',
      workspaceId: 'workspace-v3',
      occurredAt: '2099-01-01T00:00:00.000Z'
    }).success).toBe(false);
    expect(runtimeResultSchema.parse({
      kind: 'conversation.message.accepted.v3',
      sessionId: 'session-v3',
      sessionVersion: 2,
      messageId: 'message-v3',
      messageVersion: 1,
      sagaId: 'saga-v3'
    })).toMatchObject({ kind: 'conversation.message.accepted.v3' });
    expect(runtimeResultSchema.parse({
      kind: 'conversation.session.updated.v3',
      sessionId: 'session-v3',
      version: 2
    })).toMatchObject({ kind: 'conversation.session.updated.v3' });
  });

  it('projects only safe image metadata and permits an image-only user Message', () => {
    const attachment = {
      attachmentId: `sha256:${'b'.repeat(64)}`,
      mediaType: 'image/webp' as const,
      bytes: 1_024,
      width: 800,
      height: 600,
      name: 'diagram.webp'
    };
    expect(publicMessageProjectionV3Schema.parse({
      messageId: 'message-image-projection',
      sessionId: 'session-image-projection',
      version: 1,
      role: 'user',
      content: '',
      attachments: [attachment],
      status: 'completed',
      createdAt: TIME,
      updatedAt: TIME
    }).attachments).toEqual([attachment]);
    expect(publicMessageProjectionV3Schema.safeParse({
      messageId: 'message-image-assistant',
      sessionId: 'session-image-projection',
      version: 1,
      role: 'assistant',
      content: 'answer',
      attachments: [attachment],
      status: 'completed',
      createdAt: TIME,
      updatedAt: TIME
    }).success).toBe(false);
  });

  it('defines strict direct-parent continuable SubAgent send receipts', () => {
    const command = {
      kind: 'agent.subagent.send.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: 'run-parent',
      childRunId: 'run-child',
      sessionId: 'session-subagent',
      inputId: 'input-follow-up',
      content: 'Continue with the bounded follow-up.'
    } as const;
    expect(runtimeCommandSchema.parse(command)).toEqual(command);
    expect(runtimeCommandSchema.safeParse({
      ...command,
      delivery: 'next_step'
    }).success).toBe(false);
    expect(runtimeResultSchema.parse({
      kind: 'agent.subagent.input.sent.v3',
      parentRunId: command.parentRunId,
      childRunId: command.childRunId,
      childRunVersion: 5,
      inputId: command.inputId,
      inputVersion: 1
    })).toMatchObject({
      kind: 'agent.subagent.input.sent.v3',
      childRunVersion: 5
    });

    const interrupt = {
      kind: 'agent.subagent.interrupt.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      parentRunId: command.parentRunId,
      childRunId: command.childRunId,
      sessionId: command.sessionId,
      expectedChildVersion: 5,
      occurredAt: '2026-08-28T00:00:00.000Z',
      reason: 'user_requested'
    } as const;
    expect(runtimeCommandSchema.parse(interrupt)).toEqual(interrupt);
    expect(runtimeCommandSchema.safeParse({
      ...interrupt,
      keepInbox: true
    }).success).toBe(false);
    expect(runtimeResultSchema.parse({
      kind: 'agent.subagent.interrupted.v3',
      parentRunId: command.parentRunId,
      childRunId: command.childRunId,
      childRunVersion: 7,
      previousStatus: 'active'
    })).toMatchObject({
      kind: 'agent.subagent.interrupted.v3',
      previousStatus: 'active'
    });
  });

  it('defines a strict opaque Decision resolution command and result', () => {
    const actionToken = `decision-action.v1:${'a'.repeat(64)}`;
    const command = {
      kind: 'agent.decision.resolve.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-decision-v3',
      decisionId: 'decision-v3',
      action: {
        contractVersion: '1.0',
        actionToken,
        choice: 'approve'
      }
    } as const;
    expect(runtimeCommandSchema.parse(command)).toEqual(command);
    expect(runtimeResultSchema.parse({
      kind: 'agent.decision.resolved.v3',
      runId: command.runId,
      decisionId: command.decisionId,
      runVersion: 4
    })).toMatchObject({ kind: 'agent.decision.resolved.v3', runVersion: 4 });

    for (const privateField of [
      { permissionItems: [] },
      { plan: { content: 'private plan body' } },
      { path: 'C:\\private\\repo' }
    ]) {
      expect(runtimeCommandSchema.safeParse({ ...command, ...privateField }).success)
        .toBe(false);
    }
    expect(runtimeCommandSchema.safeParse({
      ...command,
      action: { ...command.action, actionToken: 'C:\\private\\token' }
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      ...command,
      action: { ...command.action, privatePlanBody: 'do not accept' }
    }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({
      kind: 'agent.decision.resolved.v3',
      runId: command.runId,
      decisionId: command.decisionId,
      runVersion: 4,
      replayed: true
    }).success).toBe(false);

    const answerCommand = {
      ...command,
      decisionId: 'decision-user-question',
      action: {
        ...command.action,
        choice: 'answer' as const,
        answer: 'local: Local only'
      }
    };
    expect(runtimeCommandSchema.parse(answerCommand)).toEqual(answerCommand);
    expect(runtimeCommandSchema.safeParse({
      ...answerCommand,
      action: { ...answerCommand.action, answer: '   ' }
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      ...answerCommand,
      action: { ...answerCommand.action, answer: undefined }
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      ...command,
      action: { ...command.action, answer: 'must not accompany a plan choice' }
    }).success).toBe(false);
  });

  it('hashes only a fully validated canonical Decision authority source', async () => {
    const source = {
      kind: 'permission',
      decisionId: 'decision-token',
      runId: 'run-token',
      checkpoint: { runId: 'run-token', version: 3 },
      requestedAt: TIME,
      effectId: 'effect-token',
      toolCallId: 'tool-call-token',
      capabilityIds: ['workspace.read', 'workspace.write'],
      scope: ['workspace']
    } as const;
    await expect(publicDecisionActionTokenV1(source, 'session-token'))
      .resolves.toMatch(/^decision-action\.v1:[0-9a-f]{64}$/u);

    for (const invalid of [
      { ...source, checkpoint: { ...source.checkpoint, runId: 'run-other' } },
      { ...source, checkpoint: { ...source.checkpoint, version: Number.NaN } },
      { ...source, requestedAt: '2032-01-01T00:00:00Z' },
      { ...source, capabilityIds: ['workspace.write', 'workspace.read'] },
      { ...source, privatePlanBody: 'must not enter the token preimage' }
    ]) {
      await expect(publicDecisionActionTokenV1(invalid, 'session-token')).rejects.toThrow();
    }
  });

  it('exports a strict ordered commit without changing the v2 snapshot contract', () => {
    const commit = projectionCommitV3Schema.parse({
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      eventId: 'event-1',
      sourceId: 'conversation',
      sourceCursor: 1,
      occurredAt: TIME,
      changes: [{
        feature: 'sessions',
        operation: 'upsert',
        aggregateId: 'session-1',
        aggregateVersion: 1,
        projectedAt: TIME,
        dto: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          version: 1,
          title: 'Session',
          pinned: false,
          status: 'active',
          createdAt: TIME,
          updatedAt: TIME
        }
      }]
    });
    expect(commit.changes).toHaveLength(1);
    expect(runtimeSnapshotSchema.parse({
      revision: 0,
      capturedAt: TIME,
      runs: [],
      permissions: [],
      planHandoffs: [],
      proposals: []
    }).revision).toBe(0);
  });

  it('rejects noncanonical time, extra keys, DTO identity drift, and non-null deletes', () => {
    expect(publicProjectionCanonicalTimestampSchema.safeParse(
      '2032-02-30T00:00:00.000Z'
    ).success).toBe(false);
    const base = {
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      eventId: 'event-1',
      sourceId: 'conversation',
      sourceCursor: 1,
      occurredAt: TIME,
      changes: [{
        feature: 'sessions' as const,
        operation: 'upsert' as const,
        aggregateId: 'session-1',
        aggregateVersion: 1,
        projectedAt: TIME,
        dto: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          version: 1,
          title: 'Session',
          pinned: false,
          status: 'active',
          createdAt: TIME,
          updatedAt: TIME
        }
      }]
    };
    expect(projectionCommitV3Schema.safeParse({ ...base, privateValue: true }).success)
      .toBe(false);
    expect(projectionCommitV3Schema.safeParse({
      ...base,
      changes: [{ ...base.changes[0], aggregateId: 'different-session' }]
    }).success).toBe(false);
    expect(projectionCommitV3Schema.safeParse({
      ...base,
      changes: [{ ...base.changes[0], operation: 'delete' }]
    }).success).toBe(false);
  });

  it('exposes only an opaque, versioned action descriptor for pending decisions', () => {
    const pending = {
      decisionId: 'decision-1',
      runId: 'run-1',
      sessionId: 'session-1',
      version: 2,
      kind: 'permission' as const,
      status: 'pending' as const,
      presentation: {
        contractVersion: '1.0' as const,
        kind: 'permission' as const,
        headline: 'Permission required',
        summary: 'Tool workspace.write requests the listed capabilities before it can run.',
        toolName: 'workspace.write',
        capabilityIds: ['workspace.write'],
        scopeIds: ['workspace-primary'],
        resourceSummary: 'The permission applies only to the listed resource scope identifiers.'
      },
      requestedAt: TIME,
      action: {
        contractVersion: '1.0' as const,
        actionToken: `decision-action.v1:${'a'.repeat(64)}`,
        choices: ['allow_once', 'allow_run', 'deny'] as const
      }
    };

    expect(publicDecisionProjectionV3Schema.parse(pending)).toEqual(pending);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      sessionId: undefined
    }).success).toBe(false);

    const userQuestion = {
      ...pending,
      decisionId: 'decision-user-question',
      kind: 'user_question' as const,
      presentation: {
        contractVersion: '1.0' as const,
        kind: 'user_question' as const,
        headline: 'Agent needs your input',
        question: 'Which deployment target should be used?',
        options: [
          { optionId: 'local', label: 'Local only' },
          {
            optionId: 'remote',
            label: 'Remote host',
            description: 'Requires network access.'
          }
        ],
        allowsFreeText: true as const
      },
      action: {
        contractVersion: '1.0' as const,
        actionToken: pending.action.actionToken,
        choices: ['answer'] as const
      }
    };
    expect(publicDecisionProjectionV3Schema.parse(userQuestion)).toEqual(userQuestion);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...userQuestion,
      presentation: {
        ...userQuestion.presentation,
        options: [userQuestion.presentation.options[0]]
      }
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...userQuestion,
      action: { ...userQuestion.action, choices: ['approve'] }
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      permissionItems: [{ path: 'C:\\private\\secret.txt' }]
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      presentation: { ...pending.presentation, kind: 'plan' }
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      presentation: {
        ...pending.presentation,
        capabilityIds: ['workspace.write', 'workspace.read']
      }
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      action: { ...pending.action, choices: ['allow_once', 'deny'] }
    }).success).toBe(false);
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...pending,
      status: 'approved',
      resolvedAt: TIME
    }).success).toBe(false);
    const { action: _pendingAction, ...terminal } = pending;
    expect(publicDecisionProjectionV3Schema.parse({
      ...terminal,
      status: 'approved',
      resolvedAt: TIME
    })).not.toHaveProperty('action');

    const planPresentation = {
      contractVersion: '1.0' as const,
      kind: 'plan' as const,
      headline: 'Plan approval required',
      summary: 'Apply the reviewed refactoring in bounded stages.',
      impactSummary: 'The plan changes workspace files and runs verification.',
      approvalScope: 'continue_run_with_presented_plan' as const,
      steps: [{
        title: 'Implement the slice',
        summary: 'Change only the reviewed workspace modules.',
        impact: 'workspace_change' as const
      }]
    };
    expect(publicDecisionProjectionV3Schema.parse({
      ...terminal,
      kind: 'plan',
      presentation: planPresentation,
      status: 'rejected',
      resolvedAt: TIME
    })).toMatchObject({ presentation: planPresentation });
    expect(publicDecisionProjectionV3Schema.safeParse({
      ...terminal,
      kind: 'plan',
      presentation: {
        ...planPresentation,
        steps: [{ ...planPresentation.steps[0], privateInput: 'hidden' }]
      },
      status: 'rejected',
      resolvedAt: TIME
    }).success).toBe(false);
  });

  it('defines complete snapshot and reset-required batch envelopes', () => {
    expect(publicProjectionSnapshotV3Schema.parse({
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      cursor: 0,
      cursorDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      capturedAt: TIME,
      sessions: [],
      messages: [],
      runs: [],
      decisions: [],
      models: [],
      diagnostics: [],
      inferenceStreams: [],
      tombstones: []
    }).streamId).toBe('stream-1');
    expect(publicProjectionReadBatchV3Schema.parse({
      status: 'reset_required',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      currentCursor: 4,
      reason: 'cursor_gap'
    }).status).toBe('reset_required');
  });

  it('carries deleted aggregate heads through snapshots without overlapping visible rows', () => {
    const deleted = {
      ...sessionSnapshot('Deleted session'),
      sessions: [],
      tombstones: [{
        feature: 'sessions' as const,
        aggregateId: 'session-1',
        aggregateVersion: 2,
        projectedAt: TIME
      }]
    };

    expect(assertPublicProjectionSnapshotV3(deleted).tombstones).toEqual(
      deleted.tombstones
    );
    expect(() => assertPublicProjectionSnapshotV3({
      ...deleted,
      tombstones: [deleted.tombstones[0], deleted.tombstones[0]]
    })).toThrow('public_projection_snapshot_order_invalid:tombstones');
    expect(() => assertPublicProjectionSnapshotV3({
      ...deleted,
      sessions: sessionSnapshot('Visible session').sessions
    })).toThrow('public_projection_snapshot_head_overlap:sessions');
  });

  it('rejects path and credential representations in both commits and snapshots', () => {
    const unsafeValues = [
      '[C:/Users/Admin/secret.txt]',
      'file:///home/admin/secret.txt',
      '<C:\\Users\\Admin\\secret.txt>',
      '{"apiKey":"TOPSECRET0123456789"}',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    ];
    for (const unsafe of unsafeValues) {
      expect(() => assertPublicProjectionCommitV3(sessionCommit(unsafe)))
        .toThrow();
      expect(() => assertPublicProjectionSnapshotV3(sessionSnapshot(unsafe)))
        .toThrow();
    }
    expect(() => assertPublicProjectionCommitV3(
      sessionCommit('See https://example.com/docs for public help.')
    )).not.toThrow();
  });

  it('makes cursor tokens and ordered batches canonical', () => {
    expect(publicProjectionReadBatchV3Schema.safeParse({
      status: 'ok',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      afterCursor: 4,
      afterDigest: digestOf('4'),
      nextCursor: 99,
      nextDigest: digestOf('9'),
      hasMore: false,
      commits: []
    }).success).toBe(false);

    const commit = sessionCommit('Session');
    expect(assertPublicProjectionReadBatchV3({
      status: 'ok',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      afterCursor: 0,
      afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      nextCursor: 1,
      nextDigest: digestOf('1'),
      hasMore: false,
      commits: [{ cursor: 1, cursorDigest: digestOf('1'), commit }]
    })).toMatchObject({ nextCursor: 1, nextDigest: digestOf('1') });

    expect(() => assertPublicProjectionReadBatchV3({
      status: 'ok',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      afterCursor: 0,
      afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      nextCursor: 1,
      nextDigest: digestOf('1'),
      hasMore: false,
      commits: [{
        cursor: 1,
        cursorDigest: digestOf('1'),
        commit: sessionCommit('file:///home/admin/secret.txt')
      }]
    })).toThrow('public_projection_absolute_path_forbidden');
  });

  it('bounds the complete read batch rather than only each embedded commit', () => {
    const commits = Array.from({ length: 84 }, (_, index) => {
      const cursor = index + 1;
      const id = `message-${String(cursor).padStart(3, '0')}`;
      return {
        cursor,
        cursorDigest: digestOf(cursor.toString(16)),
        commit: messageCommit(cursor, id, 'x'.repeat(100_000))
      };
    });
    expect(() => assertPublicProjectionReadBatchV3({
      status: 'ok',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      streamId: 'stream-1',
      afterCursor: 0,
      afterDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
      nextCursor: commits.at(-1)!.cursor,
      nextDigest: commits.at(-1)!.cursorDigest,
      hasMore: false,
      commits
    })).toThrow('public_projection_read_batch_too_large');
  });
});

function sessionCommit(title: string) {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: 'event-1',
    sourceId: 'conversation',
    sourceCursor: 1,
    occurredAt: TIME,
    changes: [{
      feature: 'sessions' as const,
      operation: 'upsert' as const,
      aggregateId: 'session-1',
      aggregateVersion: 1,
      projectedAt: TIME,
      dto: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        version: 1,
        title,
        pinned: false,
        status: 'active' as const,
        createdAt: TIME,
        updatedAt: TIME
      }
    }]
  };
}

function sessionSnapshot(title: string) {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    streamId: 'stream-1',
    cursor: 1,
    cursorDigest: digestOf('1'),
    capturedAt: TIME,
    sessions: [sessionCommit(title).changes[0]!.dto],
    messages: [],
    runs: [],
    decisions: [],
    models: [],
    diagnostics: [],
    inferenceStreams: [],
    tombstones: []
  };
}

function messageCommit(sourceCursor: number, messageId: string, content: string) {
  return {
    contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
    eventId: `event-${String(sourceCursor)}`,
    sourceId: 'conversation',
    sourceCursor,
    occurredAt: TIME,
    changes: [{
      feature: 'messages' as const,
      operation: 'upsert' as const,
      aggregateId: messageId,
      aggregateVersion: 1,
      projectedAt: TIME,
      dto: {
        messageId,
        sessionId: 'session-1',
        version: 1,
        role: 'assistant' as const,
        content,
        status: 'completed' as const,
        createdAt: TIME,
        updatedAt: TIME
      }
    }]
  };
}

function digestOf(seed: string): string {
  const normalized = seed.replace(/[^0-9a-f]/giu, 'a').toLowerCase();
  return `sha256:${normalized.padStart(64, '0').slice(-64)}`;
}
