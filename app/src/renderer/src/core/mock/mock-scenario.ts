import { useSyncExternalStore } from 'react';

export const MOCK_SCENARIOS = [
  'blank',
  'conversation',
  'streaming',
  'proposal',
  'permission',
  'running',
  'tool-success',
  'tool-failed',
  'cancelled',
  'complete',
  'offline'
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const MOCK_SCENARIO_LABELS: Record<MockScenario, string> = {
  blank: '空白会话',
  conversation: '普通对话',
  streaming: '流式回复',
  proposal: '执行提案',
  permission: '等待权限',
  running: 'Agent 执行中',
  'tool-success': '工具成功',
  'tool-failed': '工具失败',
  cancelled: '用户取消',
  complete: '任务完成',
  offline: 'Runtime 未接入'
};

export class MockScenarioStore {
  private scenario: MockScenario = 'permission';
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): MockScenario => this.scenario;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setScenario(scenario: MockScenario): void {
    if (scenario === this.scenario) return;
    this.scenario = scenario;
    for (const listener of this.listeners) listener();
  }
}

export function useMockScenario(store: MockScenarioStore): MockScenario {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
