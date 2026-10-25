// Isolated deferred services for production productivity and permission panels.
import { ProductivityPanel } from '../src/renderer/src/modules/productivity/ProductivityPanel';
import { PermissionsPanel } from '../src/renderer/src/modules/permissions/PermissionsPanel';
import { moduleId, type ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import type { RuntimePermissionDecision } from '../src/renderer/src/core/runtime/runtime-store';
import type { ProductivitySnapshot } from '../src/renderer/src/core/runtime/features/productivity-feature-store';
import { PublicResultError } from '../src/renderer/src/core/runtime/public-result';
function source<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, update: (next: T) => { value = next; listeners.forEach(listener => listener()); } };
}
const sessions = source({ selectedSessionId: 'productivity-a', sessions: [
  { sessionId: 'productivity-a', workspaceId: 'workspace-a' }, { sessionId: 'productivity-b', workspaceId: 'workspace-b' }
] });
const queries: Array<{ workspaceId: string; sessionId: string; resolve(value: unknown): void; reject(error: Error): void }> = [];
const actions: Array<{ kind: string; input: unknown; resolve(value?: unknown): void; reject(error: Error): void }> = [];
const selectedSessions: string[] = [];
const historyQueries: Array<{ workspaceId: string; sessionId: string; before: unknown }> = [];
let retried = false;
let historyFailure = false;
let execution: unknown = null;
let sessionSelectionFailure = false;
const unhandled: string[] = [];
window.addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
let latestSnapshot: ProductivitySnapshot | null = null;
const action = (kind: string, input: unknown) => new Promise<unknown>((resolve, reject) => actions.push({ kind, input, resolve, reject }));
const permission = { requestId: 'permission-fixture', runId: 'run-fixture', sessionId: 'productivity-a', title: '【UI 夹具】访问文件', reason: '只验证决定反馈', toolName: 'fixture_tool', resourceSummary: 'fixture path', scopeIds: [], permissionItems: [], projectionVersion: 1, status: 'pending', actionAvailable: true } as unknown as RuntimePermissionDecision;
const services = {
  sessions: { view: sessions, select: async (id: string) => {
    if (sessionSelectionFailure) throw new Error('【UI 夹具】所属会话打开失败');
    selectedSessions.push(id);
  } },
  productivity: {
    taskFaults: { query: async (workspaceId: string, sessionId: string) => ({ kind: 'productivity.task_faults.query_result',
      contractVersion: '1.0', workspaceId, sessionId, faults: [], nextFaultId: null }) },
    query: (workspaceId: string, sessionId: string) => new Promise((resolve, reject) => queries.push({ workspaceId, sessionId, resolve, reject })),
    querySchedules: async () => [],
    scheduleOccurrences: {
      query: async (workspaceId: string, sessionId: string, before: unknown) => {
        historyQueries.push({ workspaceId, sessionId, before });
        if (historyFailure) throw new Error('【UI 夹具】记录读取失败');
        const item = { occurrenceId: `${sessionId}-retry`, scheduleId: `${sessionId}-schedule`, dueAt: '2026-10-04T00:00:00Z', prompt: '【UI 夹具】等待恢复的提交',
          status: execution ? 'submitted' : retried ? 'pending' : 'failed', attempts: 8, errorCode: 'schedule_submission_uncertain', canRetry: !retried };
        return { kind: 'schedule.occurrences.query_result', occurrences: before
          ? [{ ...item, occurrenceId: `${sessionId}-older`, prompt: '【UI 夹具】较早的提交', status: 'submitted', errorCode: null, canRetry: false }]
          : [item, { ...item, occurrenceId: `${sessionId}-paused`, prompt: '【UI 夹具】暂停后不能重试', canRetry: false },
            ...(execution ? [{ ...item, occurrenceId: `${sessionId}-executing`, prompt: '【UI 夹具】实际调度任务',
              status: 'submitted', errorCode: null, canRetry: false, execution }] : [])],
        nextCursor: before ? null : { dueAt: '2026-10-04T00:00:00Z', occurrenceId: `${sessionId}-paused` } };
      },
      retry: (input: unknown) => action('retryOccurrence', input)
    },
    putGoal: (input: unknown) => action('putGoal', input),
    startGoalAutonomy: (input: unknown) => action('startGoalAutonomy', input),
    transitionGoalAutonomy: (input: unknown) => action('transitionGoalAutonomy', input),
    replaceTodos: (input: unknown) => action('replaceTodos', input),
    startWorkflow: (input: unknown) => action('startWorkflow', input),
    cancelWorkflow: (input: unknown) => action('cancelWorkflow', input),
    createSchedule: (input: unknown) => action('createSchedule', input)
  },
  decisions: { view: source({ permissions: [permission], planHandoffs: [], userQuestions: [], decisionDirectory: null }), respondToPermission: (_request: unknown, choice: string) => action(choice, {}) }
} as unknown as ModuleServices;
Object.assign(window, { __productivityFixture: {
  queries, actions, unhandled, historyQueries, selectedSessions,
  markRetried: () => { retried = true; },
  failHistory: (value: boolean) => { historyFailure = value; },
  setExecution: (value: unknown) => { execution = value; },
  failSessionSelection: (value: boolean) => { sessionSelectionFailure = value; },
  selectSession: (id: string) => sessions.update({ ...sessions.getSnapshot(), selectedSessionId: id }),
  settleQuery: (index: number, title: string, fail = false, todos: ProductivitySnapshot['todos'] = [], autonomy?: NonNullable<ProductivitySnapshot['goal']>['autonomy']) => {
    const query = queries[index]!;
    if (fail) { query.reject(new Error(title)); return; }
    const snapshot: ProductivitySnapshot = { kind: 'productivity.query_result', goal: {
      goalId: `goal-${query.sessionId}`, workspaceId: query.workspaceId, sessionId: query.sessionId,
      version: index + 1, title, phase: 'active', status: autonomy?.status === 'complete' ? 'complete' : 'active', roundCap: 32, roundsUsed: 0,
      updatedAt: '2026-10-04T00:00:00Z', ...(autonomy === undefined ? {} : { autonomy })
    }, todos, todoRevision: todos.length ? 1 : null, workflows: [] };
    latestSnapshot = snapshot; query.resolve(snapshot);
  },
  settleSnapshot: (index: number, snapshot: ProductivitySnapshot) => { latestSnapshot = snapshot; queries[index]!.resolve(snapshot); },
  settleAction: (index: number, fail = false, message = '【UI 夹具】提交被拒绝') => {
    const command = actions[index]!;
    if (fail) { command.reject(message.startsWith('todo_') || message.startsWith('goal_')
      ? new PublicResultError({ code: message, message: 'The productivity command was rejected by its preconditions.', retryable: false, correlationId: 'fixture-productivity-rejection' })
      : new Error(message)); return; }
    if (command.kind === 'putGoal') {
      const input = command.input as Parameters<ModuleServices['productivity']['putGoal']>[0];
      const goal = { ...latestSnapshot!.goal!, ...input, version: (input.expectedVersion ?? 0) + 1 };
      latestSnapshot = { ...latestSnapshot!, goal }; command.resolve(goal);
    } else if (command.kind === 'replaceTodos') {
      const input = command.input as Parameters<ModuleServices['productivity']['replaceTodos']>[0];
      const revision = (input.expectedRevision ?? 0) + 1;
      latestSnapshot = { ...latestSnapshot!, todoRevision: revision, todos: input.items.map((item, ordinal) => ({ ...item, ordinal })) };
      command.resolve(revision);
    } else command.resolve();
  }
} });
export function ProductivityPageFixture({ page }: { page: string }) {
  if (page === 'productivity') return <ProductivityPanel moduleId={moduleId('productivity.main')} services={services} />;
  if (page === 'permissions') return <PermissionsPanel moduleId={moduleId('permissions.main')} services={services} />;
  return null;
}
