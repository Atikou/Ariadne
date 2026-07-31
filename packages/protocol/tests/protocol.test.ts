import { describe, expect, it } from 'vitest';
import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_MESSAGE_BYTES,
  assertRuntimeMessageSize,
  hostToRuntimeMessageSchema,
  parseHostToRuntimeMessage,
  parseRuntimeToHostMessage,
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

  it('keeps plan decisions separate from permission decisions', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'planHandoffs.respond',
      handoffId: 'handoff-1',
      decision: 'approve'
    })).toBeTruthy();

    expect(runtimeCommandSchema.safeParse({
      kind: 'planHandoffs.respond',
      handoffId: 'handoff-1',
      decision: 'allow_workspace'
    }).success).toBe(false);

    expect(runtimeCommandSchema.parse({
      kind: 'permissions.respond',
      requestId: 'permission-1',
      approvalVersion: 'version-1',
      decision: 'allow_once',
      approvedItemIds: ['item-1']
    })).toBeTruthy();

    expect(runtimeCommandSchema.parse({
      kind: 'permissions.resume',
      requestId: 'permission-1'
    })).toBeTruthy();
    expect(runtimeCommandSchema.parse({
      kind: 'planHandoffs.resume',
      handoffId: 'handoff-1'
    })).toBeTruthy();
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

  it('validates governed memory commands and rejects ambiguous edited lifecycle', () => {
    expect(runtimeCommandSchema.safeParse({
      kind: 'memories.update',
      memoryId: 'memory-1',
      value: 'updated',
      lifecycleState: 'active'
    }).success).toBe(true);
    expect(runtimeCommandSchema.safeParse({
      kind: 'memories.update',
      memoryId: 'memory-1'
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      kind: 'memories.update',
      memoryId: 'memory-1',
      value: 'updated',
      lifecycleState: 'rejected'
    }).success).toBe(false);
    expect(runtimeCommandSchema.safeParse({
      kind: 'memories.update',
      memoryId: 'memory-1',
      sensitivity: 'secret'
    }).success).toBe(false);
  });

  it('preserves narrowed Agent capabilities and exact permission approval scopes', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'approve_once',
      allowedCapabilities: ['file-read'],
      workspaceId: 'primary',
      workspaceAccess: 'read'
    })).toMatchObject({ allowedCapabilities: ['file-read'], workspaceId: 'primary', workspaceAccess: 'read' });
    expect(runtimeCommandSchema.safeParse({
      kind: 'agent.proposals.respond',
      proposalId: 'proposal-1',
      decision: 'reject',
      workspaceAccess: 'read'
    }).success).toBe(false);

    expect(permissionRequestSchema.parse({
      requestId: 'permission-1',
      runId: 'run-1',
      approvalVersion: 'version-1',
      title: '读取文件',
      reason: '需要项目配置',
      permissionItems: [{
        itemId: 'item-1',
        capability: 'read_file',
        targetLabel: 'E:\\Project\\package.json',
        reason: '读取项目配置',
        risk: 'low',
        approvalScopes: ['once', 'session', 'project', 'workspace']
      }],
      status: 'pending',
      createdAt: '2026-07-21T12:00:00.000Z'
    }).permissionItems[0]?.approvalScopes).toContain('workspace');
  });

  it('rejects unregistered arbitrary commands', () => {
    expect(runtimeCommandSchema.safeParse({ kind: 'runtime.execute', method: 'anything' }).success).toBe(false);
  });

  it('exposes opaque content-addressed Resource Registry commands without paths', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'resources.list',
      ownerType: 'session',
      ownerId: 'session-1'
    })).toMatchObject({ kind: 'resources.list', limit: 200 });
    expect(runtimeCommandSchema.parse({
      kind: 'resources.get',
      resourceId: 'resource-1'
    })).toBeTruthy();
    expect(runtimeCommandSchema.parse({
      kind: 'resources.delete',
      resourceId: 'resource-1'
    })).toBeTruthy();
  });

  it('requires a client message identity for optimistic Chat reconciliation', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-1',
      message: '立即显示这条消息',
      routingStrategy: 'privacy-first',
      resources: []
    })).toMatchObject({ clientMessageId: 'ui-message-1', routingStrategy: 'privacy-first' });

    expect(runtimeCommandSchema.safeParse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-invalid-route',
      message: '无效路由',
      routingStrategy: 'fastest',
      resources: []
    }).success).toBe(false);

    expect(runtimeCommandSchema.safeParse({
      kind: 'companion.chat.start',
      message: '缺少关联 ID',
      resources: []
    }).success).toBe(false);
  });

  it('accepts only the public Agent Plan mode on Chat start', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-plan',
      message: 'Create a plan first',
      agentMode: 'plan',
      resources: []
    })).toMatchObject({ agentMode: 'plan' });

    expect(runtimeCommandSchema.safeParse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-invalid-agent-mode',
      message: 'Implement immediately',
      agentMode: 'implement',
      resources: []
    }).success).toBe(false);
  });

  it('requires the Runtime to acknowledge the accepted Chat execution mode', () => {
    expect(runtimeResultSchema.parse({
      kind: 'companion.chat.accepted',
      runId: 'run-plan',
      sessionId: 'session-plan',
      executionMode: 'agent-plan'
    })).toMatchObject({ executionMode: 'agent-plan' });

    expect(runtimeResultSchema.safeParse({
      kind: 'companion.chat.accepted',
      runId: 'run-without-mode',
      sessionId: 'session-without-mode'
    }).success).toBe(false);
  });

  it('carries workspace ownership through session creation and Chat commands', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'companion.sessions.create',
      workspaceId: 'secondary'
    })).toMatchObject({ workspaceId: 'secondary' });
    expect(runtimeCommandSchema.parse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-workspace',
      workspaceId: 'secondary',
      message: '检查工作区',
      resources: []
    })).toMatchObject({ workspaceId: 'secondary' });
  });

  it('validates archived workspace purge commands and results', () => {
    expect(runtimeCommandSchema.parse({
      kind: 'companion.workspaces.purge',
      workspaceId: 'secondary'
    })).toEqual({
      kind: 'companion.workspaces.purge',
      workspaceId: 'secondary'
    });
    expect(runtimeResultSchema.parse({
      kind: 'companion.workspace.purged',
      workspaceId: 'secondary',
      deletedSessions: 2,
      deletedAgentContexts: 1
    })).toMatchObject({
      workspaceId: 'secondary',
      deletedSessions: 2,
      deletedAgentContexts: 1
    });
  });

  it('validates Chat input without changing the user-authored text', () => {
    const message = '  你好\n下一行  ';
    const command = runtimeCommandSchema.parse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-exact-text',
      message,
      resources: []
    });

    expect(command).toMatchObject({ message });
    expect(runtimeCommandSchema.safeParse({
      kind: 'companion.chat.start',
      clientMessageId: 'ui-message-whitespace-only',
      message: ' \n\t ',
      resources: []
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

  it('keeps budget yields distinct from crash recovery and accepts a same-Run resume command', () => {
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
    }).success).toBe(true);
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

  it('accepts public Companion messages larger than the former transport ceiling', () => {
    const content = 'x'.repeat(300_000);
    const response = parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'response',
      requestId: 'request-large-message',
      outcome: {
        ok: true,
        result: {
          kind: 'companion.messages',
          messages: [{
            messageId: 'message-large',
            sessionId: 'session-large',
            role: 'assistant',
            content,
            status: 'completed',
            createdAt: '2026-07-22T00:00:00.000Z'
          }]
        }
      }
    });

    expect(response.type).toBe('response');
    if (response.type !== 'response' || !response.outcome.ok) throw new Error('Expected a successful response.');
    expect(response.outcome.result).toMatchObject({ kind: 'companion.messages' });
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
  });

  it('validates a correlated response and monotonic event envelope shape', () => {
    expect(parseRuntimeToHostMessage({
      protocol: ARIADNE_RUNTIME_PROTOCOL,
      protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      type: 'response',
      requestId: 'request-1',
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
        aggregateType: 'runtime',
        aggregateId: 'runtime',
        aggregateVersion: 1,
        occurredAt: '2026-07-21T12:00:00.000Z',
        event: {
          kind: 'runtime.status.changed',
          status: {
            availability: 'ready',
            runtimeVersion: '0.1.0',
            protocolVersion: '2.0',
            capabilities: ['companion.chat'],
            observedAt: '2026-07-21T12:00:00.000Z'
          }
        }
      }
    }).type).toBe('event');
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
