import type { ModelSummary } from '@ariadne/protocol/public';
import { describe, expect, it } from 'vitest';

import {
  deriveChatModelState,
  type ChatModelStateInput,
  type ChatModelStateKind
} from '../src/renderer/src/modules/chat/chat-model-state';

const REMOTE_READY = model('remote-ready');
const LOCAL_READY = model('local-ready', { location: 'local' });

describe('Chat model state', () => {
  it.each<{
    name: string;
    input: Partial<ChatModelStateInput>;
    expectedKind: ChatModelStateKind;
    expectedCanChat: boolean;
    expectedStatus: string;
    expectedPlaceholder: string;
  }>([
    {
      name: 'Runtime unavailable',
      input: { runtimeAvailability: 'restarting', models: [REMOTE_READY] },
      expectedKind: 'runtime-unavailable',
      expectedCanChat: false,
      expectedStatus: '重新启动中',
      expectedPlaceholder: 'Runtime 当前不可用'
    },
    {
      name: 'plan Runtime unsupported',
      input: { planModeEnabled: true, planModeAvailable: false, models: [REMOTE_READY] },
      expectedKind: 'plan-unavailable',
      expectedCanChat: false,
      expectedStatus: '计划模式不可用',
      expectedPlaceholder: '当前 Runtime 构建不支持计划模式'
    },
    {
      name: 'no configured model',
      input: { models: [] },
      expectedKind: 'unconfigured',
      expectedCanChat: false,
      expectedStatus: '未配置模型',
      expectedPlaceholder: '请先在设置中配置 API Key'
    },
    {
      name: 'configured model checking',
      input: { models: [model('checking', { availability: 'checking' })] },
      expectedKind: 'checking',
      expectedCanChat: false,
      expectedStatus: '正在检查模型',
      expectedPlaceholder: '正在检查已配置模型'
    },
    {
      name: 'configured model unavailable',
      input: { models: [model('unavailable', { availability: 'unavailable' })] },
      expectedKind: 'unavailable',
      expectedCanChat: false,
      expectedStatus: '模型不可用',
      expectedPlaceholder: '已配置模型当前不可用'
    },
    {
      name: 'plan model lacks Agent support',
      input: {
        planModeEnabled: true,
        executionMode: 'plan',
        models: [model('plain-chat', { supportsAgent: false, supportsPlan: false })]
      },
      expectedKind: 'plan-incompatible',
      expectedCanChat: false,
      expectedStatus: '模型不支持计划模式',
      expectedPlaceholder: '已配置模型未通过计划控制能力检测'
    },
    {
      name: 'privacy-first has only remote models',
      input: { routingStrategy: 'privacy-first', models: [REMOTE_READY] },
      expectedKind: 'privacy-unavailable',
      expectedCanChat: false,
      expectedStatus: '无可用本地模型',
      expectedPlaceholder: '隐私优先仅使用本地模型'
    },
    {
      name: 'normal Chat has a ready model',
      input: { models: [REMOTE_READY] },
      expectedKind: 'ready',
      expectedCanChat: true,
      expectedStatus: '就绪',
      expectedPlaceholder: '向 Ariadne 发送消息'
    },
    {
      name: 'plan Chat has an Agent-capable ready model',
      input: { planModeEnabled: true, executionMode: 'plan', models: [REMOTE_READY] },
      expectedKind: 'ready',
      expectedCanChat: true,
      expectedStatus: '就绪',
      expectedPlaceholder: '描述需要规划的任务'
    },
    {
      name: 'privacy-first has a local ready model',
      input: { routingStrategy: 'privacy-first', models: [REMOTE_READY, LOCAL_READY] },
      expectedKind: 'ready',
      expectedCanChat: true,
      expectedStatus: '就绪',
      expectedPlaceholder: '向 Ariadne 发送消息'
    }
  ])('$name', ({ input, expectedKind, expectedCanChat, expectedStatus, expectedPlaceholder }) => {
    const state = deriveChatModelState({
      runtimeAvailability: 'ready',
      planModeAvailable: true,
      planModeEnabled: false,
      executionMode: 'chat',
      routingStrategy: 'local-first',
      models: [],
      ...input
    });

    expect(state.kind).toBe(expectedKind);
    expect(state.canChat).toBe(expectedCanChat);
    expect(state.statusLabel).toBe(expectedStatus);
    expect(state.composerPlaceholder).toContain(expectedPlaceholder);
    expect(state.statusLabel === '未配置模型').toBe(expectedKind === 'unconfigured');
  });

  it('keeps checking and unavailable configured models out of the ready lists', () => {
    const state = deriveChatModelState({
      runtimeAvailability: 'ready',
      planModeAvailable: true,
      planModeEnabled: false,
      executionMode: 'chat',
      routingStrategy: 'local-first',
      models: [
        model('checking', { availability: 'checking' }),
        model('failed', { availability: 'error' }),
        REMOTE_READY
      ]
    });

    expect(state.readyModels.map((candidate) => candidate.id)).toEqual(['remote-ready']);
    expect(state.eligibleModels.map((candidate) => candidate.id)).toEqual(['remote-ready']);
  });

  it('keeps a disabled local model out of chat candidates', () => {
    const state = deriveChatModelState({
      runtimeAvailability: 'ready',
      planModeAvailable: true,
      planModeEnabled: false,
      executionMode: 'chat',
      routingStrategy: 'local-first',
      models: [LOCAL_READY, model('local-disabled', { location: 'local', enabled: false }), REMOTE_READY]
    });

    expect(state.readyModels.map((candidate) => candidate.id)).toEqual(['local-ready', 'remote-ready']);
    expect(state.eligibleModels.map((candidate) => candidate.id)).toEqual(['local-ready', 'remote-ready']);
  });
});

function model(id: string, overrides: Partial<ModelSummary> = {}): ModelSummary {
  return {
    id,
    label: `Model ${id}`,
    location: 'remote',
    availability: 'ready',
    supportsTextChat: true,
    supportsAgent: true,
    supportsPlan: true,
    supportsVision: false,
    qualificationState: 'qualified',
    ...overrides
  };
}
