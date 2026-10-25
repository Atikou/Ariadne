// Explicit, isolated presentation fixtures. No Runtime, shell or remote calls.
import { AgentStatusPanel } from '../src/renderer/src/modules/agent-status/AgentStatusPanel';
import { AgentPlanPanel } from '../src/renderer/src/modules/agent-plan/AgentPlanPanel';
import { TerminalPanel } from '../src/renderer/src/modules/terminal/TerminalPanel';
import { moduleId, type ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import type { RuntimePlanDecision, RuntimeRun } from '../src/renderer/src/core/runtime/runtime-projection-presenter';
import { presentSession } from '../src/renderer/src/core/runtime/runtime-projection-presenter';
import type { RunFeatureSnapshot, SessionFeatureSnapshot } from '../src/renderer/src/core/runtime/features/projection-feature-snapshots';
import type { ProjectionCatalogWindow } from '../src/renderer/src/core/runtime/projection/projection-catalog-repository';
import { publicRunCatalogSummarySchema, type PublicRunCatalogSummary } from '@ariadne/protocol/public';

function source<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, update: (next: T) => { value = next; listeners.forEach(listener => listener()); } };
}
const selected = source<Pick<SessionFeatureSnapshot, 'selectedSessionId' | 'sessions'>>({ selectedSessionId: 'fixture-a', sessions: [] });
const task = { runId: 'fixture-run', sessionId: 'fixture-a', origin: 'projection', status: 'running', title: '【UI 夹具】核对当前工作区的实现与验证结果', inbox: [], progress: .4, startedAt: '2026-09-05T00:00:00Z' } as unknown as RuntimeRun;
const taskStore = source<RunFeatureSnapshot>({ runs: [task], runSummaries: [], runDirectory: null, sessionRunDirectory: null, openedRunId: null, agentInputDeliveries: [],
  activities: Array.from({ length: 8 }, (_, i) => ({ activityId: `activity-${i}`, runId: task.runId, activityType: 'tool', status: 'completed', title: `【UI 夹具】检查步骤 ${i}`,
    occurredAt: '2026-10-06T00:00:00.000Z', toolCallId: `fixture-call-${i}`, toolName: 'fixture.inspect', iteration: i, batchId: 'fixture-batch', laneId: 'fixture-tools',
    dependsOnActivityIds: [], detailAvailable: false, changedFileCount: 0 })) });
const catalogRows: PublicRunCatalogSummary[] = ['completed', 'failed', 'waiting_permission'].map((status, index) => {
  return publicRunCatalogSummarySchema.parse({ runId: `directory-task-${index}`, version: 1, status, label: '【UI 夹具】公开状态',
    startedAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', sessionId: index === 2 ? 'fixture-b' : 'fixture-a', title: index === 1 ? '【UI 夹具】长标题'.repeat(20) : 'Agent run',
    toolActivityCount: 0, queuedInputCount: 0, claimedInputCount: 0, interactionMessageCount: 0 });
});
// Only an explicit presentation window; protocol digests are checked separately
// in actual SQLite integration/native gates, never claimed by these fixtures.
function catalogWindow(rows: readonly PublicRunCatalogSummary[], pageIndex = 0): ProjectionCatalogWindow {
  return { page: { rows: rows.slice(pageIndex * 2, pageIndex * 2 + 2).map(dto => ({ feature: 'runs', dto })), pageIndex,
    totalRows: rows.length, hasMore: rows.length > (pageIndex + 1) * 2 }, bytes: 0 } as unknown as ProjectionCatalogWindow;
}
const directoryCalls: Array<{ kind: string; id: string | null }> = [];
const directoryWaits: Array<() => void> = [];
let holdSelection = false;
function selectDirectorySession(id: string): Promise<void> {
  directoryCalls.push({ kind: 'select', id }); selected.update({ ...selected.getSnapshot(), selectedSessionId: id });
  taskStore.update({ ...taskStore.getSnapshot(), runs: [], openedRunId: null, sessionRunDirectory: catalogWindow(catalogRows.filter(row => row.sessionId === id)) });
  return holdSelection ? new Promise(resolve => directoryWaits.push(resolve)) : Promise.resolve();
}
function navigateDirectory(direction: 'next' | 'previous', currentSession: boolean): Promise<void> {
  directoryCalls.push({ kind: currentSession ? 'session_' + direction : direction, id: currentSession ? selected.getSnapshot().selectedSessionId : null });
  const key = currentSession ? 'sessionRunDirectory' : 'runDirectory';
  const page = taskStore.getSnapshot()[key]?.page.pageIndex ?? 0;
  const rows = currentSession ? catalogRows.filter(row => row.sessionId === selected.getSnapshot().selectedSessionId) : catalogRows;
  return new Promise(resolve => directoryWaits.push(() => { taskStore.update({ ...taskStore.getSnapshot(), [key]: catalogWindow(rows, direction === 'next' ? page + 1 : page - 1) }); resolve(); }));
}
const basePlan = { handoffId: 'fixture-plan', sessionId: 'fixture-a', runId: task.runId, title: '【UI 夹具】改进当前页面', summary: '这是独立测试计划，不会执行任务。', impactSummary: '仅测试界面', projectionVersion: 1, plan: null, status: 'pending', actionAvailable: true, steps: Array.from({ length: 8 }, (_, i) => ({ stepId: `step-${i}`, title: `检查点 ${i}`, detail: '检查布局、状态和可访问性。' })) } as unknown as RuntimePlanDecision;
const plans = source({ permissions: [], userQuestions: [], decisionSummaries: [], decisionDirectory: null, sessionDecisionDirectory: null, openedDecisionId: null,
  planHandoffs: [basePlan, { ...basePlan, handoffId: 'other-plan', sessionId: 'fixture-b', title: 'OTHER-SESSION-PLAN' }] });
const actions: Array<{ kind: string; resolve(): void; reject(error: Error): void }> = [];
const action = (kind: string) => new Promise<void>((resolve, reject) => actions.push({ kind, resolve, reject }));
const terminals: Array<{ request: { sessionId: string; workspaceId: string; shell: string }; resolve(value: unknown): void; reject(error: Error): void }> = [];
const closed: string[] = [];
const services = {
  sessions: { view: selected, select: selectDirectorySession },
  runs: { view: taskStore, requestCancellation: () => action('cancel'), navigate: (direction: 'next' | 'previous') => navigateDirectory(direction, false),
    navigateSession: (direction: 'next' | 'previous') => navigateDirectory(direction, true), openDetail: async (id: string) => {
      directoryCalls.push({ kind: 'open', id }); const row = catalogRows.find(candidate => candidate.runId === id)!;
      taskStore.update({ ...taskStore.getSnapshot(), runs: [{ ...task, ...row } as RuntimeRun], openedRunId: id });
    } },
  decisions: { view: plans, recoveryChoices: (run: RuntimeRun) => run.cancellationPending
    ? ['mark_failed', 'cancel_run'] : ['retry', 'mark_failed', 'cancel_run'],
    resumeBudget: () => action('budget'), recoverRun: () => action('recover'), respondToPlan: (_handoff: unknown, choice: string) => action(choice) },
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
  directoryCalls, directoryWaits,
  settleDirectory: () => directoryWaits.shift()?.(),
  holdDirectorySelection: (hold: boolean) => { holdSelection = hold; },
  setDirectory: (sessionId: string | null = null, empty = false, completedOnly = false) => {
    directoryCalls.length = 0; directoryWaits.length = 0; holdSelection = false;
    selected.update({ selectedSessionId: sessionId, sessions: ['fixture-a', 'fixture-b'].map(id => presentSession({ sessionId: id, workspaceId: 'fixture-workspace', version: 1,
      pinned: false, status: 'active', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', title: id === 'fixture-a' ? '【UI 夹具】实现审查' : '【UI 夹具】等待批准' })) });
    const rows = empty ? [] : completedOnly ? catalogRows.filter(row => row.status === 'completed') : catalogRows;
    taskStore.update({ ...taskStore.getSnapshot(), runs: [], openedRunId: null, runDirectory: catalogWindow(rows), sessionRunDirectory: sessionId === null ? null : catalogWindow(rows.filter(row => row.sessionId === sessionId)) });
  },
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
