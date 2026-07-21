import type { MockScenario } from '@renderer/core/mock/mock-scenario';

export type ConversationNodeKind =
  | 'assistant'
  | 'cancelled'
  | 'complete'
  | 'error'
  | 'execution'
  | 'offline'
  | 'permission'
  | 'proposal'
  | 'streaming'
  | 'tool'
  | 'user';

export interface ConversationNode {
  id: string;
  kind: ConversationNodeKind;
  sender: string;
  time: string;
  summary: string;
  content?: string;
}

const base: ConversationNode[] = [
  {
    id: 'user-request',
    kind: 'user',
    sender: '你',
    time: '16:08',
    summary: '检查桌面端架构并完善模块化工作区',
    content: '请检查现有 Electron 架构，完善 Dockview 模块注册、布局持久化和安全边界。'
  },
  {
    id: 'assistant-response',
    kind: 'assistant',
    sender: 'Ariadne',
    time: '16:08',
    summary: '已完成项目盘点，准备按安全边界开始实施',
    content: '我已完成项目盘点。当前仓库可以沿用单主窗口架构，功能全部作为 Dockview 面板注册。\n\n接下来会先固定 Main、Preload、Renderer 的安全边界，再实现布局恢复和示例流程。'
  }
];

const overflowHistory: ConversationNode[] = Array.from({ length: 24 }, (_, index) => {
  const sequence = index + 1;
  const isUser = index % 2 === 0;
  const summary = isUser
    ? `补充需求 ${sequence}：检查长对话中的标尺滚动、悬停预览和当前位置同步`
    : `进展记录 ${sequence}：已更新模块状态并继续验证长对话导航体验`;
  return {
    id: `overflow-history-${String(sequence).padStart(2, '0')}`,
    kind: isUser ? 'user' : 'assistant',
    sender: isUser ? '你' : 'Ariadne',
    time: `15:${String(30 + index).padStart(2, '0')}`,
    summary,
    content: summary
  };
});

function prependOverflowHistory(nodes: readonly ConversationNode[]): ConversationNode[] {
  return [...overflowHistory, ...nodes];
}

const proposal: ConversationNode = {
  id: 'execution-proposal',
  kind: 'proposal',
  sender: 'Agent',
  time: '16:09',
  summary: '提出三步执行计划'
};

const permission: ConversationNode = {
  id: 'permission-request',
  kind: 'permission',
  sender: 'Agent',
  time: '16:10',
  summary: '请求读取项目并运行类型检查'
};

const execution: ConversationNode = {
  id: 'execution-progress',
  kind: 'execution',
  sender: 'Agent',
  time: '16:11',
  summary: '正在分析模块注册和布局持久化'
};

export function getConversationNodes(scenario: MockScenario): ConversationNode[] {
  switch (scenario) {
    case 'blank': return [];
    case 'conversation': return prependOverflowHistory(base);
    case 'streaming': return prependOverflowHistory([...base, streamingNode]);
    case 'proposal': return prependOverflowHistory([...base, proposal]);
    case 'permission': return prependOverflowHistory([...base, proposal, permission]);
    case 'running': return prependOverflowHistory([...base, proposal, permission, execution]);
    case 'tool-success': return prependOverflowHistory([...base, proposal, permission, execution, successNode]);
    case 'tool-failed': return prependOverflowHistory([...base, proposal, permission, execution, failedNode]);
    case 'cancelled': return prependOverflowHistory([...base, proposal, permission, cancelledNode]);
    case 'complete': return prependOverflowHistory([...base, proposal, permission, execution, successNode, completeNode]);
    case 'offline': return prependOverflowHistory([...base, offlineNode]);
  }
}

const streamingNode: ConversationNode = {
  id: 'streaming-response', kind: 'streaming', sender: 'Ariadne', time: '16:09', summary: '正在生成架构分析'
};
const successNode: ConversationNode = {
  id: 'tool-success', kind: 'tool', sender: 'Agent', time: '16:12', summary: '类型检查和构建已通过'
};
const failedNode: ConversationNode = {
  id: 'tool-failed', kind: 'error', sender: 'Agent', time: '16:12', summary: 'PowerShell 命令执行失败'
};
const cancelledNode: ConversationNode = {
  id: 'task-cancelled', kind: 'cancelled', sender: '系统', time: '16:11', summary: '任务已由用户取消'
};
const completeNode: ConversationNode = {
  id: 'task-complete', kind: 'complete', sender: 'Ariadne', time: '16:13', summary: '桌面工作区第一阶段已经完成'
};
const offlineNode: ConversationNode = {
  id: 'runtime-offline', kind: 'offline', sender: '系统', time: '16:09', summary: 'Runtime 当前尚未接入'
};
