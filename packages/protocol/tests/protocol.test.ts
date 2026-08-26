import { describe, expect, it } from 'vitest';
import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_MESSAGE_BYTES,
  assertRuntimeMessageSize,
  hostToRuntimeMessageSchema,
  parseHeadlessInput,
  parseHostToRuntimeMessage,
  parseRuntimeToHostMessage,
  agentPersistenceKeyRingSchema,
  runtimeCommandSchema
} from '../src/index.js';
import {
  companionMessageSchema,
  modelInferenceProfileSchema,
  permissionRequestSchema,
  planHandoffSchema,
  runSummarySchema,
  runtimeEventSchema,
  runtimeResultSchema
} from '../src/public.js';
import { createDefaultRuntimePolicySnapshot } from '../src/settings.js';

const runtimeInstanceId = '744b7985-512d-49ef-bc1e-7cb87674ea3f';
const runtimeBuildFingerprint = 'a'.repeat(64);

describe('Ariadne Runtime protocol', () => {
  it('requires stable command identity and an absolute deadline in Headless v3', () => {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    expect(parseHeadlessInput({
      type: 'command',
      requestId: 'headless-attempt-1',
      commandId: 'headless-command-1',
      deadlineAt,
      command: { kind: 'runtime.status.get' }
    })).toMatchObject({
      commandId: 'headless-command-1',
      deadlineAt
    });
    expect(() => parseHeadlessInput({
      type: 'command',
      requestId: 'headless-attempt-1',
      command: { kind: 'runtime.status.get' }
    })).toThrow();
  });

  it('accepts a strict private bootstrap without exposing a port or credential', () => {
    const bootstrap = parseHostToRuntimeMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'bootstrap',
      appVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      runtimeBuildFingerprint,
      installRoot: 'E:\\Ariadne\\resources\\runtime',
      dataRoot: 'C:\\Users\\example\\AppData\\Roaming\\Ariadne\\runtime',
      modelRoots: ['D:\\Models'],
      modelProviders: [{
        providerId: 'openai',
        name: 'cloud-openai',
        protocol: 'openai-compatible',
        credentialEnvironmentVariable: 'OPENAI_API_KEY',
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        inference: {}
      }],
      routingStrategy: 'cloud-first',
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: 'disabled',
        reason: 'not_configured'
      },
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: 'default',
      workspaces: [
        { workspaceId: 'primary', label: 'Project', rootPath: 'E:\\Project', access: 'write' }
      ],
      production: false
    });

    expect(bootstrap.type).toBe('bootstrap');
    expect(JSON.stringify(bootstrap)).not.toMatch(/"(?:port|token|secret|apiKey)"\s*:/i);
  });

  it('rejects unknown bootstrap fields and protocol versions', () => {
    const base = {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'bootstrap',
      appVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      runtimeBuildFingerprint,
      installRoot: 'E:\\Runtime',
      dataRoot: 'C:\\Data',
      modelRoots: [],
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: 'disabled',
        reason: 'not_configured'
      },
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: 'default',
      workspaces: [{ workspaceId: 'primary', label: 'Project', rootPath: 'E:\\Project', access: 'read' }],
      production: false
    } as const;

    expect(hostToRuntimeMessageSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(hostToRuntimeMessageSchema.safeParse({ ...base, protocolVersion: '1.0' }).success).toBe(false);
    const { runtimePolicy: _runtimePolicy, ...missingPolicy } = base;
    expect(hostToRuntimeMessageSchema.safeParse(missingPolicy).success).toBe(false);
    expect(hostToRuntimeMessageSchema.safeParse({
      ...base,
      runtimePolicy: {
        ...base.runtimePolicy,
        mcp: {
          servers: [{
            id: 'remote',
            enabled: true,
            trustAnnotations: false,
            transport: 'streamable-http',
            endpoint: 'https://mcp.example.test',
            credentialRef: 'oauth:mcp-remote',
            token: 'must-never-cross-bootstrap'
          }],
          legacySseFallback: false
        }
      }
    }).success).toBe(false);
  });

  it('requires dataRoot to be a canonical absolute Windows or POSIX path', () => {
    const base = {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'bootstrap',
      appVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      runtimeBuildFingerprint,
      installRoot: 'E:\\Runtime',
      modelRoots: [],
      agentAdmissionAuthoritySource: {
        sourceVersion: 1,
        status: 'disabled',
        reason: 'not_configured'
      },
      runtimePolicy: createDefaultRuntimePolicySnapshot(),
      profile: 'default',
      workspaces: [{ workspaceId: 'primary', label: 'Project', rootPath: 'E:\\Project', access: 'read' }],
      production: false
    } as const;

    for (const dataRoot of [
      'C:\\Data\\Runtime',
      'c:\\Data\\Runtime',
      '\\\\server\\share\\Ariadne',
      '/var/lib/ariadne/runtime'
    ]) {
      expect(hostToRuntimeMessageSchema.safeParse({ ...base, dataRoot }).success).toBe(true);
    }
    for (const dataRoot of [
      'relative/data',
      'C:relative',
      'C:/Data',
      'C:\\Data\\..\\Runtime',
      'C:\\Data\\',
      '/var/lib/../ariadne',
      '/var//lib/ariadne',
      '/var/lib/ariadne/'
    ]) {
      expect(hostToRuntimeMessageSchema.safeParse({ ...base, dataRoot }).success).toBe(false);
    }
  });

  it('keeps the Agent persistence key ring on a strict private capability', () => {
    const keyId = 'agent-key-00000000-0000-4000-8000-000000000001';
    expect(parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'capability_request',
      requestId: 'request-agent-persistence-keyring',
      capability: 'agent_persistence',
      operation: { kind: 'agent.persistence.keyring.read' }
    })).toMatchObject({
      capability: 'agent_persistence',
      operation: { kind: 'agent.persistence.keyring.read' }
    });

    expect(agentPersistenceKeyRingSchema.parse({
      schemaVersion: 1,
      runtimeInstanceId,
      generation: 1,
      activeKeyId: keyId,
      keys: [{
        keyId,
        keyMaterialBase64: Buffer.alloc(32, 7).toString('base64')
      }]
    })).toMatchObject({ activeKeyId: keyId, generation: 1 });

    expect(agentPersistenceKeyRingSchema.safeParse({
      schemaVersion: 1,
      runtimeInstanceId,
      generation: 1,
      activeKeyId: keyId,
      keys: [{
        keyId,
        keyMaterialBase64: 'not-a-32-byte-key'
      }]
    }).success).toBe(false);
    expect(agentPersistenceKeyRingSchema.safeParse({
      schemaVersion: 1,
      runtimeInstanceId,
      generation: 1,
      activeKeyId: keyId,
      keys: [
        {
          keyId,
          keyMaterialBase64: Buffer.alloc(32, 7).toString('base64')
        },
        {
          keyId: 'agent-key-00000000-0000-4000-8000-000000000002',
          keyMaterialBase64: Buffer.alloc(32, 7).toString('base64')
        }
      ]
    }).success).toBe(false);
  });

  it('rejects retired public legacy commands', () => {
    const retiredCommands = [
      {
        kind: 'permissions.respond',
        requestId: 'permission-1',
        approvalVersion: 'version-1',
        decision: 'allow_once',
        approvedItemIds: ['item-1']
      },
      { kind: 'permissions.resume', requestId: 'permission-1' },
      { kind: 'planHandoffs.respond', handoffId: 'handoff-1', decision: 'approve' },
      { kind: 'planHandoffs.resume', handoffId: 'handoff-1' },
      { kind: 'resources.update', resourceId: 'resource-1', name: 'updated' },
      { kind: 'resources.delete', resourceId: 'resource-1' },
      { kind: 'memories.update', memoryId: 'memory-1', value: 'updated' },
      { kind: 'memories.delete', memoryId: 'memory-1' },
      { kind: 'taskCheckpoints.restore', runId: 'run-1', checkpointId: 'checkpoint-1' },
      { kind: 'permissions.list' },
      { kind: 'planHandoffs.list' },
      { kind: 'companion.messages.list', sessionId: 'session-1', limit: 20 },
      { kind: 'runs.list' },
      { kind: 'runs.get', runId: 'run-1' },
      { kind: 'agent.proposals.list' }
    ];

    for (const command of retiredCommands) {
      expect(runtimeCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it('requires a versioned six-region plan contract in public handoffs', () => {
    const handoff = {
      handoffId: 'handoff-1',
      runId: 'run-1',
      sessionId: 'session-1',
      title: 'Todo 页面执行计划',
      summary: '实现一个可持久化的原生 Todo 页面。',
      steps: [{ stepId: 'step-1', title: '创建页面结构' }],
      status: 'pending',
      createdAt: '2026-07-31T00:00:00.000Z',
      plan: {
        schemaVersion: 1,
        planId: 'plan-1',
        version: 1,
        sourceRunId: 'run-1',
        sessionId: 'session-1',
        title: 'Todo 页面执行计划',
        goal: '实现一个可持久化的原生 Todo 页面。',
        facts: [{
          id: 'fact-1',
          statement: '当前工作区为空。',
          evidence: '只读目录检查结果。',
        }],
        constraints: [],
        clarifications: [],
        steps: [{
          id: 'step-1',
          title: '创建页面结构',
          dependsOn: [],
          action: '创建语义化页面控件。',
          scope: ['index.html'],
          expectedOutcome: '页面包含输入区和任务列表。',
          verification: '浏览器打开后使用键盘访问主要控件。',
          status: 'pending',
          actualScope: [],
          evidence: [],
          deviations: [],
        }],
        completionCriteria: [{
          id: 'done-1',
          behavior: '刷新后任务仍然存在。',
          verification: '添加任务后刷新并比较内容。',
        }],
        planState: 'ready_for_confirmation',
        executionState: 'not_started',
        completeness: 'complete',
        blockingReasons: [],
        qualityIssues: [],
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
    };

    expect(planHandoffSchema.parse(handoff).plan.version).toBe(1);
    const { plan: _plan, ...legacyHandoff } = handoff;
    expect(planHandoffSchema.safeParse(legacyHandoff).success).toBe(false);
  });

  it('exposes only the v3 Projection command surface', () => {
    for (const kind of [
      'companion.sessions.list',
      'companion.sessions.create',
      'companion.chat.start',
      'companion.chat.cancel',
      'events.replay',
      'models.list',
      'agent.proposals.respond',
      'runs.cancel',
      'runs.recover',
      'runs.resume',
      'resources.list',
      'memories.list',
      'trace.list'
    ]) {
      expect(runtimeCommandSchema.safeParse({ kind }).success, kind).toBe(false);
    }
  });

  it('rejects unregistered arbitrary commands', () => {
    expect(runtimeCommandSchema.safeParse({ kind: 'runtime.execute', method: 'anything' }).success).toBe(false);
  });

  it('requires authoritative session identity and version for v3 messages', () => {
    const message = '  你好\n下一行  ';
    expect(runtimeCommandSchema.parse({
      kind: 'conversation.session.create.v3',
      contractVersion: '3.0',
      sessionId: 'session-exact-text',
      workspaceId: 'secondary'
    })).toMatchObject({ sessionId: 'session-exact-text', workspaceId: 'secondary' });
    const command = runtimeCommandSchema.parse({
      kind: 'conversation.message.accept.v3',
      contractVersion: '3.0',
      sessionId: 'session-exact-text',
      workspaceId: 'secondary',
      expectedSessionVersion: 1,
      messageId: 'ui-message-exact-text',
      content: message
    });
    expect(command).toMatchObject({ content: message, expectedSessionVersion: 1 });
    expect(runtimeCommandSchema.safeParse({
      kind: 'conversation.message.accept.v3',
      contractVersion: '3.0',
      sessionId: 'session-exact-text',
      workspaceId: 'secondary',
      expectedSessionVersion: 1,
      messageId: 'ui-message-whitespace-only',
      content: ' \n\t '
    }).success).toBe(false);
  });

  it('requires every public Run to identify its cancellation owner', () => {
    const base = {
      runId: 'run-1',
      title: '测试运行',
      status: 'running',
      userFacingLabel: '执行中',
      aggregateVersion: 1,
      checkpointStage: 'running',
      recoveryStatus: 'none',
      timing: { activeDurationMs: 0 }
    } as const;
    expect(runSummarySchema.safeParse({
      ...base,
      origin: 'agent',
      detail: '上次恢复失败，可以重试'
    }).success).toBe(true);
    expect(runSummarySchema.safeParse({ ...base, origin: 'companion' }).success).toBe(true);
    expect(runSummarySchema.safeParse(base).success).toBe(false);
  });

  it('keeps budget yields visible without exposing a retired resume command', () => {
    expect(runSummarySchema.safeParse({
      runId: 'run-budget',
      origin: 'agent',
      title: 'Continue implementation',
      status: 'waiting_budget',
      userFacingLabel: '等待追加执行预算',
      aggregateVersion: 3,
      checkpointStage: 'waiting_budget',
      recoveryStatus: 'none',
      timing: { activeDurationMs: 12_000 },
      budgetExhausted: 'maxModelTurns',
      budgetUsage: {
        modelTurns: 8,
        toolCalls: 4,
        readCalls: 4,
        writeCalls: 0,
        shellCalls: 0,
        runtimeMs: 12_000
      }
    }).success).toBe(true);

    expect(runtimeCommandSchema.safeParse({
      kind: 'runs.resume',
      runId: 'run-budget',
      expectedAggregateVersion: 3,
      budget: { maxModelTurns: 12 }
    }).success).toBe(false);
  });

  it('rejects contradictory or duplicated model inference profiles', () => {
    expect(modelInferenceProfileSchema.safeParse({
      reasoning: {
        modes: ['off', 'off'],
        defaultMode: 'on',
        efforts: ['high', 'high']
      }
    }).success).toBe(false);
  });

  it('rejects oversized messages before schema parsing', () => {
    expect(() => assertRuntimeMessageSize({ data: 'x'.repeat(MAX_RUNTIME_MESSAGE_BYTES + 1) })).toThrow(
      /runtime_message_too_large/
    );
  });

  it('separates transport attempts from stable logical commands and carries an absolute deadline', () => {
    const request = {
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'request',
      commandId: 'command-runtime-status-1',
      deadlineAt: '2026-07-31T12:00:00.000Z',
      command: { kind: 'runtime.status.get' }
    } as const;

    const firstAttempt = parseHostToRuntimeMessage({
      ...request,
      requestId: 'request-attempt-1'
    });
    const retryAttempt = parseHostToRuntimeMessage({
      ...request,
      requestId: 'request-attempt-2'
    });

    expect(firstAttempt).toMatchObject({
      type: 'request',
      requestId: 'request-attempt-1',
      commandId: 'command-runtime-status-1',
      deadlineAt: '2026-07-31T12:00:00.000Z'
    });
    expect(retryAttempt).toMatchObject({
      type: 'request',
      requestId: 'request-attempt-2',
      commandId: firstAttempt.type === 'request' ? firstAttempt.commandId : undefined
    });

    expect(hostToRuntimeMessageSchema.safeParse({
      ...request,
      requestId: 'legacy-request-without-command-id',
      commandId: undefined
    }).success).toBe(false);
    expect(hostToRuntimeMessageSchema.safeParse({
      ...request,
      requestId: 'legacy-request-without-deadline',
      deadlineAt: undefined
    }).success).toBe(false);
  });

  it('cancels a logical command explicitly instead of treating a local timeout as completion', () => {
    expect(parseHostToRuntimeMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'cancel',
      cancelRequestId: 'cancel-attempt-1',
      targetRequestId: 'request-attempt-1',
      commandId: 'command-runtime-status-1',
      reason: 'deadline_exceeded'
    })).toMatchObject({
      type: 'cancel',
      cancelRequestId: 'cancel-attempt-1',
      targetRequestId: 'request-attempt-1',
      commandId: 'command-runtime-status-1',
      reason: 'deadline_exceeded'
    });

    expect(hostToRuntimeMessageSchema.safeParse({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'cancel',
      cancelRequestId: 'cancel-attempt-1',
      targetRequestId: 'request-attempt-1',
      reason: 'deadline_exceeded'
    }).success).toBe(false);

    expect(parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'cancel_acknowledged',
      cancelRequestId: 'cancel-attempt-1',
      targetRequestId: 'request-attempt-1',
      commandId: 'command-runtime-status-1',
      status: 'accepted'
    })).toMatchObject({
      type: 'cancel_acknowledged',
      status: 'accepted'
    });
  });

  it('uses an absolute deadline for the complete Runtime shutdown chain', () => {
    expect(parseHostToRuntimeMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'shutdown',
      requestId: 'shutdown-attempt-1',
      reason: 'app_quit',
      deadlineAt: '2026-07-31T12:00:00.000Z'
    })).toMatchObject({
      type: 'shutdown',
      deadlineAt: '2026-07-31T12:00:00.000Z'
    });

    expect(hostToRuntimeMessageSchema.safeParse({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'shutdown',
      requestId: 'legacy-relative-shutdown',
      reason: 'app_quit',
      deadlineMs: 10_000
    }).success).toBe(false);
  });

  it('keeps reasoning separate from final content in messages and stream events', () => {
    expect(companionMessageSchema.parse({
      messageId: 'assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '最终回答',
      status: 'completed',
      createdAt: '2026-07-22T00:00:00.000Z',
      reasoning: {
        content: '检查约束',
        status: 'completed',
        source: 'provider',
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:00:02.000Z',
        durationMs: 2_000,
        segments: [{
          segmentId: 'segment-1',
          kind: 'thought',
          content: '检查约束',
          occurredAt: '2026-07-22T00:00:01.000Z',
          iteration: 1
        }]
      }
    })).toMatchObject({
      content: '最终回答',
      reasoning: {
        content: '检查约束',
        segments: [{ segmentId: 'segment-1', kind: 'thought' }]
      }
    });

    expect(runtimeEventSchema.safeParse({
      kind: 'companion.reasoning.delta',
      runId: 'run-1',
      sessionId: 'session-1',
      messageId: 'assistant-1',
      text: '检查',
      source: 'provider',
      startedAt: '2026-07-22T00:00:00.000Z'
    }).success).toBe(true);
    expect(runtimeEventSchema.safeParse({
      kind: 'projection.changed',
      feature: 'models'
    }).success).toBe(true);
  });

  it('validates a correlated response and monotonic event envelope shape', () => {
    expect(parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'response',
      requestId: 'request-1',
      commandId: 'command-1',
      outcome: {
        ok: true,
        result: { kind: 'acknowledged' }
      }
    }).type).toBe('response');

    expect(parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'event',
      event: {
        eventId: 'event-1',
        cursor: 1,
        schemaVersion: '2.0',
        aggregateType: 'trace',
        aggregateId: 'trace-1',
        aggregateVersion: 1,
        occurredAt: '2026-07-21T12:00:00.000Z',
        event: {
          kind: 'trace.appended',
          entry: {
            traceId: 'trace-1',
            level: 'info',
            category: 'protocol-test',
            message: 'Runtime event.',
            occurredAt: '2026-07-21T12:00:00.000Z'
          }
        }
      }
    }).type).toBe('event');
  });

  it('returns a structured correlated error without throwing domain details across the host boundary', () => {
    const response = parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'response',
      requestId: 'request-attempt-3',
      commandId: 'command-runtime-status-1',
      outcome: {
        ok: false,
        error: {
          code: 'runtime_busy',
          message: 'Runtime is at capacity.',
          retryable: true,
          correlationId: 'correlation-runtime-status-1'
        }
      }
    });

    expect(response).toMatchObject({
      type: 'response',
      requestId: 'request-attempt-3',
      commandId: 'command-runtime-status-1',
      outcome: {
        ok: false,
        error: {
          code: 'runtime_busy',
          retryable: true,
          correlationId: 'correlation-runtime-status-1'
        }
      }
    });

    expect(() => parseRuntimeToHostMessage({
      ...response,
      outcome: {
        ok: false,
        error: {
          code: 'runtime_busy',
          message: 'Runtime is at capacity.',
          retryable: true
        }
      }
    })).toThrow();
  });

  it('carries a structured user-visible error on interrupted Companion messages', () => {
    const message = parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'event',
      event: {
        eventId: 'event-2',
        cursor: 2,
        schemaVersion: '2.0',
        aggregateType: 'companion',
        aggregateId: 'message-interrupted',
        aggregateVersion: 1,
        occurredAt: '2026-07-22T00:00:00.000Z',
        event: {
          kind: 'companion.message.changed',
          message: {
            messageId: 'message-interrupted',
            sessionId: 'session-interrupted',
            role: 'assistant',
            content: '已收到的部分内容',
            status: 'interrupted',
            createdAt: '2026-07-22T00:00:00.000Z',
            error: {
              code: 'COMPANION_TURN_PROTOCOL_ERROR',
              message: 'Agent 提案格式无效，请重试。',
              retryable: true
            }
          }
        }
      }
    });

    expect(message).toMatchObject({
      type: 'event',
      event: {
        event: {
          message: {
            status: 'interrupted',
            error: { code: 'COMPANION_TURN_PROTOCOL_ERROR', retryable: true }
          }
        }
      }
    });
  });

  it('keeps Browser capability traffic on the private Runtime-to-Main protocol', () => {
    const request = parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'capability_request',
      requestId: 'browser-request-1',
      capability: 'browser',
      operation: {
        kind: 'browser.navigate',
        url: 'https://example.test/'
      }
    });
    expect(request).toMatchObject({
      type: 'capability_request',
      capability: 'browser',
      operation: { kind: 'browser.navigate' }
    });

    const response = parseHostToRuntimeMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'capability_response',
      requestId: 'browser-request-1',
      outcome: {
        ok: true,
        result: { available: true }
      }
    });
    expect(response).toMatchObject({
      type: 'capability_response',
      outcome: { ok: true, result: { available: true } }
    });

    expect(() => parseRuntimeToHostMessage({
      ...request,
      operation: { kind: 'browser.navigate', url: 'file:///etc/passwd' }
    })).toThrow();
  });

  it('keeps remote MCP JSON-RPC typed while credentials remain opaque', () => {
    const request = parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'capability_request',
      requestId: 'mcp-request-1',
      capability: 'mcp_remote',
      operation: {
        kind: 'mcp.remote.connect',
        serverId: 'docs',
        endpoint: 'https://mcp.example.test/messages',
        credentialRef: 'mcp.docs'
      }
    });
    expect(request).toMatchObject({
      capability: 'mcp_remote',
      operation: {
        kind: 'mcp.remote.connect',
        credentialRef: 'mcp.docs'
      }
    });
    expect(JSON.stringify(request)).not.toContain('access_token');

    expect(() => parseRuntimeToHostMessage({
      ...request,
      operation: {
        kind: 'mcp.remote.send',
        connectionId: '861ff28e-9b93-4eb7-8451-76dbb0bb3002',
        message: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          unexpected: true
        }
      }
    })).toThrow();
  });
});
