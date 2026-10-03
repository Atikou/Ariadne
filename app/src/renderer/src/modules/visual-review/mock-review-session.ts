export type ReviewActorId = 'user' | 'agent' | 'tools' | 'workspace' | 'verifier';
export type ReviewFileStatus = 'created' | 'modified';
export type ReviewDiffLineKind = 'context' | 'added' | 'removed';

export interface ReviewActor {
  readonly id: ReviewActorId;
  readonly name: string;
  readonly role: string;
}

export interface ReviewDiffLine {
  readonly kind: ReviewDiffLineKind;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface ReviewFileChange {
  readonly path: string;
  readonly status: ReviewFileStatus;
  readonly added: number;
  readonly removed: number;
  readonly summary: string;
  readonly diff: readonly ReviewDiffLine[];
}

export interface ReviewEvent {
  readonly id: string;
  readonly time: string;
  readonly duration: string;
  readonly from: ReviewActorId;
  readonly to: ReviewActorId;
  readonly title: string;
  readonly summary: string;
  readonly operation: 'request' | 'read' | 'plan' | 'edit' | 'generate' | 'verify' | 'report';
  readonly status: 'completed';
  readonly evidence: readonly string[];
  readonly files: readonly ReviewFileChange[];
}

export interface ReviewFileSummary {
  readonly path: string;
  readonly status: ReviewFileStatus;
  readonly added: number;
  readonly removed: number;
  readonly eventIds: readonly string[];
}

export interface MockReviewSession {
  readonly id: 'DEMO-SESSION-NOT-REAL';
  readonly title: string;
  readonly branch: 'DEMO-BRANCH';
  readonly startedAt: string;
  readonly duration: string;
  readonly actors: readonly ReviewActor[];
  readonly events: readonly ReviewEvent[];
}

const actors: readonly ReviewActor[] = [
  { id: 'user', name: '你', role: '需求提出者' },
  { id: 'agent', name: '主 Agent', role: '修改执行者' },
  { id: 'tools', name: '工具模块', role: '命令与生成器' },
  { id: 'workspace', name: '工作区', role: '文件变更' },
  { id: 'verifier', name: '验证器', role: '测试与验收' }
];

export const MOCK_REVIEW_SESSION: MockReviewSession = {
  id: 'DEMO-SESSION-NOT-REAL',
  title: '【模拟】新增可视化审查模块',
  branch: 'DEMO-BRANCH',
  startedAt: '10:42:05',
  duration: '2分18秒',
  actors,
  events: [
    {
      id: 'demo-request',
      time: '10:42:05',
      duration: '4秒',
      from: 'user',
      to: 'agent',
      title: '提出可视化审查需求',
      summary: '要求用完整时序图解释本次会话中谁修改了哪些文件。',
      operation: 'request',
      status: 'completed',
      evidence: ['用户消息已进入当前会话', '范围限定为 UI 原型与模拟数据'],
      files: []
    },
    {
      id: 'demo-inspect',
      time: '10:42:12',
      duration: '18秒',
      from: 'agent',
      to: 'workspace',
      title: '审阅现有 UI 模块边界',
      summary: '读取模块描述符、Dockview 布局和现有会话活动面板。',
      operation: 'read',
      status: 'completed',
      evidence: ['只读检查 6 个文件', '确认 UI Catalog 由目录自动生成'],
      files: [{
        path: 'app/src/renderer/src/modules/session-activity/SessionActivityPanel.tsx',
        status: 'modified',
        added: 0,
        removed: 0,
        summary: '仅作为设计参照，本事件没有写入文件。',
        diff: []
      }]
    },
    {
      id: 'demo-plan',
      time: '10:42:34',
      duration: '11秒',
      from: 'agent',
      to: 'user',
      title: '形成三栏审查方案',
      summary: '确定文件索引、时序泳道、事件 Diff 与引用栏四个区域。',
      operation: 'plan',
      status: 'completed',
      evidence: ['不替换现有会话活动模块', '原型不注册 Runtime 写入能力'],
      files: []
    },
    {
      id: 'demo-edit-panel',
      time: '10:42:51',
      duration: '46秒',
      from: 'agent',
      to: 'workspace',
      title: '创建可视化审查面板',
      summary: '新增时序图、事件检查器和模拟会话数据。',
      operation: 'edit',
      status: 'completed',
      evidence: ['使用独立模块目录', '所有演示内容带有模拟数据标识'],
      files: [
        {
          path: 'app/src/renderer/src/modules/visual-review/VisualReviewPanel.tsx',
          status: 'created',
          added: 214,
          removed: 0,
          summary: '新增三栏可视化审查工作台和事件引用交互。',
          diff: [
            { kind: 'context', oldLine: 0, newLine: 1, text: "import { useMemo, useState } from 'react';" },
            { kind: 'added', newLine: 18, text: 'export function VisualReviewPanel(): React.JSX.Element {' },
            { kind: 'added', newLine: 19, text: '  const [selectedEventId, setSelectedEventId] = useState(...)' },
            { kind: 'added', newLine: 20, text: '  return <section className="visual-review-panel">' },
            { kind: 'added', newLine: 21, text: '    <SequenceDiagram events={session.events} />' },
            { kind: 'added', newLine: 22, text: '    <ReviewInspector event={selectedEvent} />' },
            { kind: 'added', newLine: 23, text: '  </section>;' },
            { kind: 'context', oldLine: 0, newLine: 24, text: '}' }
          ]
        },
        {
          path: 'app/src/renderer/src/modules/visual-review/visual-review.css',
          status: 'created',
          added: 286,
          removed: 0,
          summary: '新增时序泳道、Diff、文件列表与引用栏样式。',
          diff: [
            { kind: 'added', newLine: 1, text: '.visual-review-panel {' },
            { kind: 'added', newLine: 2, text: '  display: grid;' },
            { kind: 'added', newLine: 3, text: '  grid-template-rows: auto auto minmax(0, 1fr) auto;' },
            { kind: 'added', newLine: 4, text: '  height: 100%;' },
            { kind: 'added', newLine: 5, text: '}' }
          ]
        }
      ]
    },
    {
      id: 'demo-generate',
      time: '10:43:41',
      duration: '3秒',
      from: 'agent',
      to: 'tools',
      title: '生成 UI 组件目录',
      summary: '生成器发现 visual-review 目录并写入静态 Catalog。',
      operation: 'generate',
      status: 'completed',
      evidence: ['目录排序稳定', 'Catalog 新增 1 个受审计组件'],
      files: [{
        path: 'app/src/renderer/src/core/modules/UiComponentCatalog.generated.ts',
        status: 'modified',
        added: 2,
        removed: 0,
        summary: '自动导入并注册 visualReviewModule。',
        diff: [
          { kind: 'context', oldLine: 14, newLine: 14, text: "import { toolOutputModule } from '@renderer/modules/tool-output';" },
          { kind: 'added', newLine: 15, text: "import { visualReviewModule } from '@renderer/modules/visual-review';" },
          { kind: 'context', oldLine: 31, newLine: 32, text: '  toolOutputModule,' },
          { kind: 'added', newLine: 33, text: '  visualReviewModule,' }
        ]
      }]
    },
    {
      id: 'demo-verify',
      time: '10:43:49',
      duration: '29秒',
      from: 'agent',
      to: 'verifier',
      title: '执行组件与窗口验收',
      summary: '完成类型检查、组件目录检查和真实 Electron 窗口截图。',
      operation: 'verify',
      status: 'completed',
      evidence: ['TypeScript：通过', 'UI Catalog：通过', 'Electron 窗口：通过'],
      files: []
    },
    {
      id: 'demo-report',
      time: '10:44:23',
      duration: '0秒',
      from: 'agent',
      to: 'user',
      title: '交付 UI 原型',
      summary: '向用户展示截图，等待确认后再设计真实 Projection 与持久化协议。',
      operation: 'report',
      status: 'completed',
      evidence: ['未接入真实会话数据', '未向 Agent 发送真实引用'],
      files: []
    }
  ]
};

export function collectReviewFiles(events: readonly ReviewEvent[]): readonly ReviewFileSummary[] {
  const summaries = new Map<string, {
    status: ReviewFileStatus;
    added: number;
    removed: number;
    eventIds: string[];
  }>();
  for (const event of events) {
    for (const file of event.files) {
      if (file.added === 0 && file.removed === 0) continue;
      const current = summaries.get(file.path);
      if (current) {
        current.status = current.status === 'created' || file.status === 'created' ? 'created' : 'modified';
        current.added += file.added;
        current.removed += file.removed;
        current.eventIds.push(event.id);
      } else {
        summaries.set(file.path, {
          status: file.status,
          added: file.added,
          removed: file.removed,
          eventIds: [event.id]
        });
      }
    }
  }
  return [...summaries.entries()].map(([path, value]) => ({ path, ...value }));
}

export function createEventReference(event: ReviewEvent): string {
  const files = event.files
    .filter((file) => file.added > 0 || file.removed > 0)
    .map((file) => `- ${file.path} (+${String(file.added)} / -${String(file.removed)})`);
  return [
    `【模拟·可视化审查引用】${event.time} ${event.title}`,
    event.summary,
    ...(files.length > 0 ? ['涉及文件：', ...files] : []),
    `事件引用：${event.id}`
  ].join('\n');
}
