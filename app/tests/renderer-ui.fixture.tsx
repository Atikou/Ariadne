// Isolated UI fixtures: no Preload, Runtime, credentials, network, or user stores.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Mic, Send } from 'lucide-react';
import type { ModuleServices } from '../src/renderer/src/core/modules/module-contract';
import { moduleId } from '../src/renderer/src/core/modules/module-contract';
import type { ModuleRegistry } from '../src/renderer/src/core/modules/module-registry';
import { ToolOutputPanel } from '../src/renderer/src/modules/tool-output/ToolOutputPanel';
import { FileExplorerPanel } from '../src/renderer/src/modules/file-explorer/FileExplorerPanel';
import { LogsPanel } from '../src/renderer/src/modules/logs/LogsPanel';
import { CommandPalette } from '../src/renderer/src/app/CommandPalette';
import { ConfirmDialog, TextPromptDialog } from '../src/renderer/src/shared/ui/ActionDialog';
import { ModalSurface } from '../src/renderer/src/shared/ui/ModalSurface';
import { SelectMenu } from '../src/renderer/src/shared/ui/SelectMenu';
import { SettingsDialog } from '../src/renderer/src/modules/settings/SettingsDialog';
import { ChatPanel } from '../src/renderer/src/modules/chat/ChatPanel';
import type { RuntimeMessage } from '../src/renderer/src/core/runtime/runtime-store';
import { AGENT_PROVIDER_IDS, createDefaultAssistantChatProfile } from '../src/shared/contract';
import 'dockview-react/dist/styles/dockview.css';
import '../src/renderer/src/app/styles.css';
import { TaskPageFixture } from './renderer-task-pages.fixture';
import { WorkspaceFixture } from './renderer-workspace.fixture';

function source<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: T) => { snapshot = next; listeners.forEach(listener => listener()); }
  };
}

const sessions = source({ selectedSessionId: 'session-a', sessions: [
  { sessionId: 'session-a', workspaceId: 'workspace-a' },
  { sessionId: 'session-b', workspaceId: 'workspace-b' }
] });
const runs = source({ runs: [{ runId: 'run-a', sessionId: 'session-a' }], activities: Array.from({ length: 18 }, (_, index) => ({
  activityId: `tool-${index}`, runId: 'run-a', activityType: 'tool', status: index === 0 ? 'running' : 'completed',
  title: `【UI 夹具】文件检查 ${index}`, summary: '只用于界面验证，不是真实调用。',
  occurredAt: '2026-09-05T00:00:00Z', detailAvailable: index > 0
})) });
const pending: Array<{ effectId: string; cursor: number; resolve(value: unknown): void }> = [];
const directoryRequests: string[] = [];
const services = {
  runs: { view: runs }, sessions: { view: sessions },
  toolResults: { loadDetail: (_run: string, _workspace: string, effectId: string, cursor = 0) => new Promise(resolve => pending.push({ effectId, cursor, resolve })) },
  conversationNavigation: {
    getSelectedWorkspaceId: () => 'workspace-a',
    onSelectedWorkspaceChanged: () => () => {},
    listWorkspaces: async () => []
  },
  workspace: { listDirectory: async ({ relativePath }: { relativePath: string }) => {
    directoryRequests.push(relativePath);
    return { rootLabel: '【UI 夹具】工作区', entries: relativePath === '' ? [
      { name: 'src', relativePath: 'src', type: 'directory' },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `file-${i}.ts`, relativePath: `file-${i}.ts`, type: 'file' }))
    ] : [{ name: 'index.ts', relativePath: 'src/index.ts', type: 'file' }] };
  } },
  diagnostics: { view: source({ trace: [], status: { availability: 'ready' } }) },
  models: { view: source({ models: [] }) },
  speech: source({ status: { availability: 'disabled', detail: '【UI 夹具】未连接语音', inputDevices: [], outputDevices: [], voices: [], capabilities: [] } }),
  preferences: { load: async () => ({ runInBackground: false, startAtLogin: false, theme: 'light', suppressAutomaticWakeDuringGames: false, gameDetectionRules: [], speech: {
    enabled: false, moduleRoot: '', foregroundSttMode: 'compose', backgroundWakeEnabled: false, wakeKeywords: [], listenWhenLocked: false, inputDeviceId: 'default', outputDeviceId: 'default', activeVoiceId: null, activeVoiceVersion: null
  } }) },
  agentSettings: { load: async () => ({ schemaVersion: 7, revision: 1, assistant: createDefaultAssistantChatProfile(), routingStrategy: 'balanced', permissionMode: 'default', workspaceAccess: 'read', workspaces: [], localModelRoots: [], subagentProviders: [], providers: Object.fromEntries(AGENT_PROVIDER_IDS.map(id => [id, { enabled: false, baseUrl: '', model: '', contextWindowTokens: 32768, maxOutputTokens: 4096, inference: {}, apiKeyStatus: 'missing' }])) }) },
  applicationProfile: { id: 'ui-fixture', revision: 1, digest: 'fixture-only', entities: [{ entity: 'speech', componentIds: ['speech.core', 'speech.bridge.renderer'] }] },
  humanSkills: { queryCommands: async () => [], loadCommand: async () => { throw new Error('No fixture skill'); } }
} as unknown as ModuleServices;
const registry = { list: () => Array.from({ length: 18 }, (_, i) => ({ id: `module-${i}`, name: `测试模块 ${i}`, description: 'UI 交互测试，不执行任务', icon: 'bot' })) } as unknown as ModuleRegistry;

const chatMessages = source<{ messages: RuntimeMessage[] }>({ messages: [] });
const chatServices = {
  ...services,
  diagnostics: { view: source({ status: { availability: 'ready', capabilities: [] } }), refresh: async () => {} },
  messages: { view: chatMessages },
  models: { view: source({ models: [{ id: 'fixture-model', label: '【UI 夹具】模型', availability: 'ready', location: 'local', supportsTextChat: true, inference: {} }] }) },
  runs: { view: source({ runs: [], activities: [], agentInputDeliveries: [] }) },
  sessions: { view: source({ sessions: [], selectedSessionId: null }), isPlanModeEnabled: () => false },
  decisions: { view: source({ permissions: [], planHandoffs: [], userQuestions: [] }) },
  events: { subscribe: () => () => {} },
  system: { onApprovalNavigation: () => () => {} },
  conversationNavigation: {
    ...services.conversationNavigation,
    getSessionPresentationRevision: () => 0,
    onSessionPresentationChanged: () => () => {},
    onWorkspacesChanged: () => () => {},
    listSelectableWorkspaces: async () => []
  }
} as unknown as ModuleServices;

const api = {
  show: (_page: string) => {},
  opened: [] as string[],
  directories: directoryRequests,
  switchSession: (id: string) => sessions.update({ ...sessions.getSnapshot(), selectedSessionId: id }),
  resolveDetail: (index: number, content: string, complete = true) => {
    const request = pending[index];
    if (!request) throw new Error(`Missing detail request ${index}`);
    request.resolve({
      effectId: request.effectId, runId: 'run-a', workspaceId: 'workspace-a',
      cursor: request.cursor, nextCursor: request.cursor + content.length, complete,
      content, digest: 'ui-fixture-digest', status: 'completed', totalBytes: 100,
      presentation: { kind: 'text', label: '【UI 夹具】工具结果' }
    });
  },
  pendingCount: () => pending.length,
  setChatHistory: (count: number) => chatMessages.update({ messages: Array.from({ length: count }, (_, i) => ({
    messageId: `fixture-message-${i}`, sessionId: 'fixture-chat', role: 'user', status: 'completed', content: `【UI 夹具】消息 ${i}`, createdAt: '2026-09-05T00:00:00Z'
  })) })
};
Object.assign(window, { __uiFixture: api });

function DialogFixtures() {
  const [dialog, setDialog] = useState<'confirm' | 'prompt' | 'settings' | 'select' | null>(null);
  const [nested, setNested] = useState(false);
  const [value, setValue] = useState('a');
  const [promptName, setPromptName] = useState('示例名称');
  const initialRef = useRef<HTMLButtonElement>(null);
  return <>
    {(['confirm', 'prompt', 'settings', 'select'] as const).map(kind => <button key={kind} id={`open-${kind}`} onClick={() => setDialog(kind)}>{kind}</button>)}
    <button id="background-action">背景按钮</button>
    <ConfirmDialog open={dialog === 'confirm'} title="【UI 夹具】确认" description="只验证交互，不删除内容。" confirmLabel="确认" danger onClose={() => setDialog(null)} onConfirm={() => setDialog(null)} />
    <TextPromptDialog open={dialog === 'prompt'} title="【UI 夹具】重命名" description="不修改真实会话。" initialValue={promptName} confirmLabel="保存" onClose={() => setDialog(null)} onConfirm={value => { api.opened.push(value); setPromptName(value); setDialog(null); }} />
    <SettingsDialog open={dialog === 'settings'} moduleId={moduleId('settings.main')} services={services} onClose={() => setDialog(null)} />
    <ModalSurface open={dialog === 'select'} className="action-dialog-backdrop" labelledBy="select-dialog-title" initialFocusRef={initialRef} onClose={() => setDialog(null)}>
      <section className="action-dialog" style={{ display: 'flex', flexDirection: 'column' }}>
        <h2 id="select-dialog-title">【UI 夹具】嵌套弹层</h2>
        <button ref={initialRef} id="before-select">前一个控件</button>
        <SelectMenu value={value} onChange={setValue} ariaLabel="测试下拉菜单" options={[{ value: 'a', label: '选项 A' }, { value: 'b', label: '选项 B' }, { value: 'group', label: '子菜单', children: [{ value: 'child', label: '子选项' }, { value: 'child-b', label: '子选项 2' }, { value: 'child-c', label: '子选项 3' }] }]} />
        <button id="after-select" onClick={() => setNested(true)}>打开子弹窗</button>
        <ConfirmDialog open={nested} title="【UI 夹具】子弹窗" description="验证焦点回到父弹窗。" confirmLabel="确认" onClose={() => setNested(false)} onConfirm={() => setNested(false)} />
      </section>
    </ModalSurface>
  </>;
}

function Fixture() {
  const [page, setPage] = useState('tools');
  const [open, setOpen] = useState(false);
  api.show = page => { setPage(page); setOpen(false); };
  return <>
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 40, padding: 10, fontSize: 12 }}>【UI 验收夹具 · 非真实数据】</div>
    <div style={{ position: 'fixed', inset: '40px 0 0', overflow: 'hidden' }}>
      {page === 'tools' && <ToolOutputPanel moduleId={moduleId('tools.output')} services={services} />}
      {page === 'files' && <FileExplorerPanel moduleId={moduleId('files.explorer')} services={services} />}
      {page === 'logs' && <LogsPanel moduleId={moduleId('logs.main')} services={services} />}
      {page === 'dialogs' && <DialogFixtures />}
      {page === 'chat' && <ChatPanel moduleId={moduleId('chat.main')} services={chatServices} />}
      <TaskPageFixture page={page} />
      {page === 'workspace' && <WorkspaceFixture />}
      {page === 'composer-controls' && <div className="composer"><div className="composer-actions">
        <button className="composer-mic-button" aria-label="测试麦克风"><Mic size={16} /></button>
        <button className="send-button" aria-label="测试发送"><Send size={16} /></button>
        <button className="send-button send-button--stop" aria-label="测试停止"><span className="send-stop-glyph" aria-hidden="true" /></button>
        <button className="send-button send-button--stop" disabled aria-label="测试停止中"><span className="send-stop-glyph" aria-hidden="true" /></button>
      </div></div>}
      {page === 'palette' && <><button id="fixture-opener" onClick={() => setOpen(true)}>打开搜索</button><CommandPalette open={open} registry={registry} humanSkills={services.humanSkills} workspaceId="workspace-a" onClose={() => setOpen(false)} onOpenModule={id => { api.opened.push(id); }} /></>}
    </div>
  </>;
}

document.documentElement.dataset.theme = 'light';
createRoot(document.getElementById('root')!).render(<Fixture />);
