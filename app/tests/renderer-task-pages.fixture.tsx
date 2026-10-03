// Explicit, isolated presentation fixtures. No Runtime, shell or remote calls.
import { AgentStatusPanel } from '../src/renderer/src/modules/agent-status/AgentStatusPanel';
import { AgentPlanPanel } from '../src/renderer/src/modules/agent-plan/AgentPlanPanel';
import { TerminalPanel } from '../src/renderer/src/modules/terminal/TerminalPanel';
import { moduleId, type ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import type { RuntimePlanDecision, RuntimeRun } from '../src/renderer/src/core/runtime/runtime-projection-presenter';

function source<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, update: (next: T) => { value = next; listeners.forEach(listener => listener()); } };
}
const selected = source({ selectedSessionId: 'fixture-a', sessions: [] });
const task = { runId: 'fixture-run', sessionId: 'fixture-a', origin: 'projection', status: 'running', title: '【UI 夹具】核对当前工作区的实现与验证结果', inbox: [], progress: .4, startedAt: '2026-09-05T00:00:00Z' } as unknown as RuntimeRun;
const taskStore = source({ runs: [task], activities: Array.from({ length: 8 }, (_, i) => ({ activityId: `activity-${i}`, runId: task.runId, activityType: 'tool', status: 'completed', title: `【UI 夹具】检查步骤 ${i}` })) });
const basePlan = { handoffId: 'fixture-plan', sessionId: 'fixture-a', runId: task.runId, title: '【UI 夹具】改进当前页面', summary: '这是独立测试计划，不会执行任务。', impactSummary: '仅测试界面', projectionVersion: 1, plan: null, status: 'pending', actionAvailable: true, steps: Array.from({ length: 8 }, (_, i) => ({ stepId: `step-${i}`, title: `检查点 ${i}`, detail: '检查布局、状态和可访问性。' })) } as unknown as RuntimePlanDecision;
const plans = source({ permissions: [], userQuestions: [], planHandoffs: [basePlan, { ...basePlan, handoffId: 'other-plan', sessionId: 'fixture-b', title: 'OTHER-SESSION-PLAN' }] });
const actions: Array<{ kind: string; resolve(): void; reject(error: Error): void }> = [];
const action = (kind: string) => new Promise<void>((resolve, reject) => actions.push({ kind, resolve, reject }));
const terminals: Array<{ request: { sessionId: string; workspaceId: string; shell: string }; resolve(value: unknown): void; reject(error: Error): void }> = [];
const closed: string[] = [];
const services = {
  sessions: { view: selected },
  runs: { view: taskStore, requestCancellation: () => action('cancel') },
  decisions: { view: plans, resumeBudget: () => action('budget'), recoverRun: () => action('recover'), respondToPlan: (_handoff: unknown, choice: string) => action(choice) },
  terminal: {
    create: (request: { sessionId: string; workspaceId: string; shell: string }) => new Promise((resolve, reject) => terminals.push({ request, resolve, reject })),
    close: ({ sessionId }: { sessionId: string }) => { closed.push(sessionId); },
    write: () => { throw new Error('Fixture must never send terminal commands'); },
    resize: () => {}, onOutput: () => () => {}, onExit: () => () => {},
    listRecoveryRecords: async () => [{ sessionId: 'fixture-interrupted', workspaceId: 'fixture-workspace', shell: 'powershell', status: 'interrupted' }]
  }
} as unknown as ModuleServices;

Object.assign(window, { __taskFixture: {
  actions, terminals, closed,
  settleAction: (index: number, fail = false) => fail ? actions[index]!.reject(new Error('【UI 夹具】提交失败')) : actions[index]!.resolve(),
  setRun: (patch: Partial<RuntimeRun>) => taskStore.update({ ...taskStore.getSnapshot(), runs: [{ ...task, ...patch }] }),
  selectSession: (id: string) => selected.update({ selectedSessionId: id, sessions: [] }),
  setPlan: (patch: Partial<RuntimePlanDecision>) => plans.update({ ...plans.getSnapshot(), planHandoffs: [{ ...basePlan, ...patch }, plans.getSnapshot().planHandoffs[1]!] }),
  settleTerminal: (index: number, fail = false) => {
    const terminal = terminals[index]!;
    if (fail) terminal.reject(new Error('【UI 夹具】启动失败'));
    else terminal.resolve({ ...terminal.request, cwd: 'E:\\UI-Fixture\\long-directory-for-layout-verification' });
  }
} });

export function TaskPageFixture({ page }: { page: string }) {
  if (page === 'agent-status') return <AgentStatusPanel moduleId={moduleId('agent.status')} services={services} />;
  if (page === 'agent-plan') return <AgentPlanPanel moduleId={moduleId('agent.plan')} services={services} />;
  if (page === 'terminal') return <TerminalPanel moduleId={moduleId('terminal.main')} services={services} />;
  return null;
}
