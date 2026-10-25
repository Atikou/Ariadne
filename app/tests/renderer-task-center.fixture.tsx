// Explicit presentation fixtures; no Source databases, Provider, permissions or user data.
import { runtimeCommandSchema, taskCenterPageSchema, type RuntimeCommand, type RuntimeResult,
  type TaskDirectoryRow, type TaskCenterFilter, type TaskCenterPage } from '@ariadne/protocol/public';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { moduleId } from '../src/renderer/src/core/modules/module-contract';
import { TaskCenterPanel } from '../src/renderer/src/modules/task-center/TaskCenterPanel';
import { TaskCenterFeatureStore } from '../src/renderer/src/core/runtime/features/task-center-feature-store';
import type { UserPreferences } from '../src/shared/contract';

const time = '2026-10-06T00:00:00.000Z';
function source<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: T) => { value = next; listeners.forEach(listener => listener()); } };
}
const selected = source({ selectedSessionId: 'session-a', sessions: [
  { workspaceId: 'workspace-a', sessionId: 'session-a' }, { workspaceId: 'workspace-b', sessionId: 'session-b' }
] });
let selectedWorkspace: string | null = 'workspace-a';
const loadedRuns = source({ runs: [] as Array<{ runId: string; sessionId: string; aggregateVersion: number }> });
const commands: RuntimeCommand[] = [], navigation: Array<{ kind: string; id: string }> = [];
let preferences: UserPreferences = { runInBackground: false, startAtLogin: false, theme: 'light', suppressAutomaticWakeDuringGames: false,
  gameDetectionRules: [], taskNotifications: { completed: false, failed: false }, speech: { enabled: false, moduleRoot: '',
    foregroundSttMode: 'compose', backgroundWakeEnabled: false, wakeKeywords: [], listenWhenLocked: false,
    inputDeviceId: 'default', outputDeviceId: 'default', activeVoiceId: null, activeVoiceVersion: null } };
const relations: TaskDirectoryRow['metadata']['relations'] = Array.from({ length: 45 }, (_, index) => ({
  reference: { source: 'run', sourceId: `fixture-related-${String(index).padStart(3, '0')}` },
  owner: { workspaceId: 'workspace-a', sessionId: 'session-a' }, kind: 'execution' }));
const rows: TaskDirectoryRow[] = [
  { source: 'run', id: 'waiting-run', state: 'waiting_confirmation', status: 'waiting_permission' },
  { source: 'goal', id: 'fixture-goal', state: 'running', status: 'active' },
  { source: 'run', id: 'completed-run', state: 'completed', status: 'completed' },
  { source: 'run', id: 'failed-run', state: 'failed', status: 'failed' },
  { source: 'occurrence', id: 'unknown-occurrence', state: 'unknown', status: 'submitted' },
  { source: 'run', id: 'foreign-run', state: 'cancelling', status: 'cancelling' }
].map((input, index) => ({ metadata: { reference: { source: input.source, sourceId: input.id },
  workspaceId: index === 5 ? 'workspace-b' : 'workspace-a', sessionId: index === 5 ? 'session-b' : 'session-a',
  title: index === 1 ? '【UI 夹具】长目标标题'.repeat(18) : `【UI 夹具】${input.id}`, sourceStatus: input.status,
  state: input.state, version: input.source === 'occurrence' ? null : 3, attempts: input.source === 'occurrence' ? 1 : null,
  updatedAt: time, dueAt: null, relations: index === 1 ? relations.slice(0, 2) : [], relationTotal: index === 1 ? relations.length : 0,
  runReferences: [], runReferenceTotal: 0 }, archived: false,
  decisions: index === 0 ? [{ workspaceId: 'workspace-a', sessionId: 'session-a', runId: input.id, decisionId: 'exact-decision', version: 2, kind: 'permission' }] : [],
  result: index === 2 ? 'available' : 'none' })) as TaskDirectoryRow[];
const snapshots = new Map<string, { filter: TaskCenterFilter; rows: TaskDirectoryRow[] }>();
let sequence = 0, staleNavigation = false;
function query(command: Extract<RuntimeCommand, { kind: 'tasks.query' }>): TaskCenterPage {
  let snapshotId: string, offset = 0;
  if (command.cursor) { const cursor = command.cursor.split('.'); snapshotId = cursor[0]!; offset = Number(cursor[1]); }
  else {
    snapshotId = 'fixture-query-' + ++sequence;
    snapshots.set(snapshotId, { filter: command.filter, rows: rows.filter(row => (!command.filter.workspaceId || command.filter.workspaceId === row.metadata.workspaceId)
      && (!command.filter.sessionId || command.filter.sessionId === row.metadata.sessionId) && command.filter.sources.includes(row.metadata.reference.source)
      && (!command.filter.states.length || command.filter.states.includes(row.metadata.state))
      && (!command.filter.reference || command.filter.reference.source === row.metadata.reference.source && command.filter.reference.sourceId === row.metadata.reference.sourceId)) });
  }
  const snapshot = snapshots.get(snapshotId)!;
  return taskCenterPageSchema.parse({ kind: 'tasks.query_result', contractVersion: '1.0', snapshotId, capturedAt: time,
    expiresAt: '2026-10-06T00:05:00.000Z', consistency: 'eventual', complete: true, filter: snapshot.filter,
    watermarks: ['projection', 'productivity', 'conversation'].map(source => ({ source, status: 'ready', revision: 1, capturedAt: time, diagnosticCode: null })),
    indexedTotal: snapshot.rows.length, rows: snapshot.rows.slice(offset, offset + 2), pageCursor: `${snapshotId}.${offset}`,
    nextCursor: offset + 2 < snapshot.rows.length ? `${snapshotId}.${offset + 2}` : null });
}
const tasks = new TaskCenterFeatureStore({ execute: async input => {
  const command = runtimeCommandSchema.parse(input); commands.push(command);
  if (command.kind === 'tasks.query') return query(command);
  if (command.kind === 'tasks.relations') return { kind: 'tasks.relations_result', contractVersion: '1.0',
    reference: command.reference, workspaceId: command.workspaceId, sessionId: command.sessionId,
    expectedVersion: command.expectedVersion, expectedAttempts: command.expectedAttempts, expectedSourceStatus: command.expectedSourceStatus,
    afterIndex: command.afterIndex, status: staleNavigation ? 'stale' : 'ok',
    rows: staleNavigation ? [] : relations.slice(command.afterIndex, command.afterIndex + command.limit),
    sourceTotal: staleNavigation ? null : relations.length,
    nextIndex: staleNavigation || command.afterIndex + command.limit >= relations.length ? null : command.afterIndex + command.limit };
  if (command.kind !== 'tasks.navigate') throw new Error('Fixture only accepts task reads.');
  const row = rows.find(row => row.metadata.reference.sourceId === command.reference.sourceId)!;
  const moduleId = command.destination === 'decision' ? 'permissions' : command.destination === 'result' ? 'chat.main'
    : row.metadata.reference.source === 'run' ? 'agent.status' : 'productivity.control';
  return { kind: 'tasks.navigate_result', contractVersion: '1.0', status: staleNavigation ? 'stale' : 'ok', reference: command.reference,
    workspaceId: command.workspaceId, sessionId: command.sessionId, current: row.metadata,
    target: staleNavigation ? null : { moduleId, workspaceId: command.workspaceId, sessionId: command.sessionId,
      runId: row.metadata.reference.source === 'run' ? command.reference.sourceId : null,
      expectedRunVersion: row.metadata.reference.source === 'run' ? 3 : null,
      decisionId: command.decisionId, expectedDecisionVersion: command.expectedDecisionVersion,
      resultReference: command.destination === 'result' ? { messageId: 'exact-result', messageVersion: 1, sessionId: command.sessionId, contentDigest: `sha256:${'a'.repeat(64)}` } : null }
  } as RuntimeResult;
} });
const services = { tasks,
  preferences: { load: async () => structuredClone(preferences), update: async (value: UserPreferences) => { preferences = structuredClone(value); return structuredClone(preferences); } },
  conversationNavigation: { listWorkspaces: async () => [{ workspaceId: 'workspace-a', name: '【UI 夹具】A' }, { workspaceId: 'workspace-b', name: '【UI 夹具】B' }],
    onWorkspacesChanged: () => () => {}, getSelectedWorkspaceId: () => selectedWorkspace, isWorkspaceActive: () => true,
    selectWorkspace: async (id: string) => { selectedWorkspace = id; navigation.push({ kind: 'workspace', id }); }, selectAssistant: () => { selectedWorkspace = null; } },
  sessions: { view: selected, select: async (id: string) => { selected.update({ ...selected.getSnapshot(), selectedSessionId: id }); navigation.push({ kind: 'session', id }); },
    resolveMessage: async () => ({ workspaceId: selectedWorkspace, role: 'assistant' }) },
  runs: { view: loadedRuns, openDetail: async (id: string) => { loadedRuns.update({ runs: [{ runId: id, sessionId: selected.getSnapshot().selectedSessionId, aggregateVersion: 3 }] }); navigation.push({ kind: 'run', id }); } },
  decisions: { openDetail: async (id: string) => { navigation.push({ kind: 'decision', id }); }, isPendingDecisionLoaded: (id: string) => id === 'exact-decision' },
  messages: { showWindow: async (input: { anchorMessageId: string }) => { navigation.push({ kind: 'message', id: input.anchorMessageId }); } },
  events: { emit: (_event: string, id: string) => { navigation.push({ kind: 'module', id }); } }
} as unknown as ModuleServices;
Object.assign(window, { __taskCenterFixture: { tasks, commands, navigation, preferences: () => structuredClone(preferences), setStale: (value: boolean) => { staleNavigation = value; } } });
export function TaskCenterFixture({ page }: { page: string }) {
  return page === 'task-center' ? <TaskCenterPanel moduleId={moduleId('tasks.center')} services={services} /> : null;
}
