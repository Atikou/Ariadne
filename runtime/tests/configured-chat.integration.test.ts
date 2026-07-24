import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARIADNE_RUNTIME_PROTOCOL,
  ARIADNE_RUNTIME_PROTOCOL_VERSION,
  type RuntimeBootstrap
} from '@ariadne/protocol/host';
import type { RuntimeEvent } from '@ariadne/protocol/public';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('configured Provider Chat', () => {
  it('checks the configured model and completes a streaming Companion reply', async () => {
    const originalFetch = globalThis.fetch;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalEmbeddingProvider = process.env.COMPANION_EMBEDDING_PROVIDER;
    const requestedUrls: string[] = [];
    const requestedBodies: Array<Record<string, unknown>> = [];
    process.env.OPENAI_API_KEY = 'integration-test-key';
    process.env.COMPANION_EMBEDDING_PROVIDER = 'local';
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrls.push(request.url);
      if (request.url.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'ariadne-test-model', object: 'model', created: 0, owned_by: 'ariadne' }]
        });
      }
      if (request.url.endsWith('/chat/completions')) {
        requestedBodies.push(await request.clone().json() as Record<string, unknown>);
        const payload = [
          'data: {"id":"chatcmpl-ariadne","object":"chat.completion.chunk","created":0,"model":"ariadne-test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"配置后的 Chat "}}]}',
          '',
          'data: {"id":"chatcmpl-ariadne","object":"chat.completion.chunk","created":0,"model":"ariadne-test-model","choices":[{"index":0,"delta":{"content":"可以正常回复。"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          ''
        ].join('\n');
        return new Response(payload, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return Response.json({ error: { message: 'unexpected test request' } }, { status: 404 });
    };

    const { createRuntimeContext } = await import('../src/application/createRuntimeContext.js');
    const { RuntimeFacade } = await import('../src/application/RuntimeFacade.js');
    const app = createRuntimeContext(createBootstrap());
    const events: RuntimeEvent[] = [];
    const facade = new RuntimeFacade(app, (event) => events.push(event), '0.1.0-test');
    app.start();

    try {
      const catalog = await facade.handle({ kind: 'models.check', modelId: 'cloud-openai' });
      expect({ catalog, requestedUrls }).toMatchObject({
        catalog: {
          kind: 'models.catalog',
          models: [{ id: 'cloud-openai', availability: 'ready' }]
        },
        requestedUrls: expect.arrayContaining([expect.stringMatching(/\/models$/)])
      });

      const userMessage = '  请验证已配置 Provider 的 Chat 链路。\n第二行保留空白。  ';
      const accepted = await facade.handle({
        kind: 'companion.chat.start',
        clientMessageId: 'ui-message-configured-chat',
        message: userMessage,
        modelId: 'cloud-openai',
        inference: { reasoningMode: 'on', reasoningEffort: 'high' },
        resources: []
      });
      expect(accepted.kind).toBe('companion.chat.accepted');
      if (accepted.kind !== 'companion.chat.accepted') throw new Error('unexpected Chat result');

      await waitFor(() => events.some((event) =>
        event.kind === 'run.changed'
        && event.run.runId === accepted.runId
        && event.run.status === 'completed'));

      const messages = await facade.handle({
        kind: 'companion.messages.list',
        sessionId: accepted.sessionId,
        limit: 20
      });
      expect(messages).toMatchObject({
        kind: 'companion.messages',
        messages: expect.arrayContaining([
          expect.objectContaining({
            messageId: 'ui-message-configured-chat',
            role: 'user',
            content: userMessage,
            status: 'completed'
          }),
          expect.objectContaining({
            role: 'assistant',
            content: '配置后的 Chat 可以正常回复。',
            status: 'completed'
          })
        ])
      });
      expect(requestedUrls.some((url) => url.endsWith('/models'))).toBe(true);
      expect(requestedUrls.some((url) => url.endsWith('/chat/completions'))).toBe(true);
      expect(requestedBodies[0]).toMatchObject({
        reasoning_effort: 'high',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: userMessage })
        ])
      });
    } finally {
      await app.shutdown();
      globalThis.fetch = originalFetch;
      restoreEnvironment('OPENAI_API_KEY', originalOpenAiKey);
      restoreEnvironment('COMPANION_EMBEDDING_PROVIDER', originalEmbeddingProvider);
    }
  }, 30_000);

  it('repairs a mixed-text Agent proposal without reinterpreting the AI capability request', async () => {
    const originalFetch = globalThis.fetch;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalEmbeddingProvider = process.env.COMPANION_EMBEDDING_PROVIDER;
    const requestedBodies: Array<Record<string, unknown>> = [];
    const draft = {
      reason: '开始实现前需要读取工作区结构，请批准本次 Agent 检查。',
      interpretedTask: '读取工作区并确认 3D 地球网页项目的现有结构。',
      requestedCapabilities: ['shell', 'file-write', 'browser', 'file-read'],
      risk: 'write'
    };
    const envelope = `<ariadne-agent-proposal>\n${JSON.stringify(draft)}\n</ariadne-agent-proposal>`;
    process.env.OPENAI_API_KEY = 'integration-test-key';
    process.env.COMPANION_EMBEDDING_PROVIDER = 'local';
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'ariadne-test-model', object: 'model', created: 0, owned_by: 'ariadne' }]
        });
      }
      if (request.url.endsWith('/chat/completions')) {
        const body = await request.clone().json() as Record<string, unknown>;
        requestedBodies.push(body);
        if (body.stream === false) {
          return Response.json({
            id: 'chatcmpl-ariadne-proposal-repair',
            object: 'chat.completion',
            created: 0,
            model: 'ariadne-test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: envelope }, finish_reason: 'stop' }]
          });
        }
        return openAiStream([`我先说明一下，请确认以下提案：${envelope}`]);
      }
      return Response.json({ error: { message: 'unexpected test request' } }, { status: 404 });
    };

    const { createRuntimeContext } = await import('../src/application/createRuntimeContext.js');
    const { RuntimeFacade } = await import('../src/application/RuntimeFacade.js');
    const app = createRuntimeContext(createBootstrap());
    const events: RuntimeEvent[] = [];
    const facade = new RuntimeFacade(app, (event) => events.push(event), '0.1.0-test');
    app.start();

    try {
      await facade.handle({ kind: 'models.check', modelId: 'cloud-openai' });
      const accepted = await facade.handle({
        kind: 'companion.chat.start',
        clientMessageId: 'ui-message-protocol-repair',
        message: '开始实现 3D 地球项目',
        modelId: 'cloud-openai',
        workspaceId: 'primary',
        resources: []
      });
      expect(accepted.kind).toBe('companion.chat.accepted');
      if (accepted.kind !== 'companion.chat.accepted') throw new Error('unexpected Chat result');

      await waitFor(() => events.some((event) =>
        event.kind === 'run.changed'
        && event.run.runId === accepted.runId
        && ['completed', 'failed'].includes(event.run.status)));

      expect(requestedBodies).toHaveLength(2);
      expect(requestedBodies[1]).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('上一条响应包含 Agent 提案标记')
          })
        ])
      });
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'run.changed',
        run: expect.objectContaining({ status: 'failed' })
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'agent.proposal.changed',
        proposal: expect.objectContaining({
          sessionId: accepted.sessionId,
          status: 'pending',
          requestedCapabilities: ['file-read', 'file-write', 'browser', 'shell'],
          risk: 'write'
        })
      }));

      const messages = await facade.handle({
        kind: 'companion.messages.list',
        sessionId: accepted.sessionId,
        limit: 20
      });
      expect(messages).toMatchObject({
        kind: 'companion.messages',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: '我已开始处理；需要额外权限时，系统会向你确认具体操作。',
            status: 'completed'
          })
        ])
      });
    } finally {
      await app.shutdown();
      globalThis.fetch = originalFetch;
      restoreEnvironment('OPENAI_API_KEY', originalOpenAiKey);
      restoreEnvironment('COMPANION_EMBEDDING_PROVIDER', originalEmbeddingProvider);
    }
  }, 30_000);
});

function createBootstrap(): RuntimeBootstrap {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-chat-data-'));
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-chat-workspace-'));
  temporaryRoots.push(dataRoot, workspaceRoot);
  return {
    protocol: ARIADNE_RUNTIME_PROTOCOL,
    protocolVersion: ARIADNE_RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: randomUUID(),
    type: 'bootstrap',
    appVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    installRoot: packageRoot,
    dataRoot,
    modelRoots: [],
    profile: 'default',
    workspaces: [{
      workspaceId: 'primary',
      label: 'Temporary workspace',
      rootPath: workspaceRoot,
      access: 'write'
    }],
    modelProviders: [{
      providerId: 'openai',
      name: 'cloud-openai',
      protocol: 'openai-compatible',
      credentialEnvironmentVariable: 'OPENAI_API_KEY',
      enabled: true,
      baseUrl: 'https://api.example.test/v1',
      model: 'ariadne-test-model',
      inference: {
        reasoning: {
          modes: ['on'],
          defaultMode: 'on',
          efforts: ['low', 'high'],
          defaultEffort: 'low'
        }
      }
    }],
    routingStrategy: 'cloud-first',
    production: false
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for completed Chat run');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function openAiStream(chunks: readonly string[]): Response {
  const payload = chunks.flatMap((content, index) => [
    `data: ${JSON.stringify({
      id: 'chatcmpl-ariadne-proposal',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'ariadne-test-model',
      choices: [{
        index: 0,
        delta: { ...(index === 0 ? { role: 'assistant' } : {}), content },
        finish_reason: index === chunks.length - 1 ? 'stop' : null
      }]
    })}`,
    ''
  ]).concat(['data: [DONE]', '']).join('\n');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}
