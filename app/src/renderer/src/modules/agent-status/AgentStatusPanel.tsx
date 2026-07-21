import { CirclePause, Clock3, ShieldCheck, Square, Wrench } from 'lucide-react';
import { useMockScenario } from '@renderer/core/mock/mock-scenario';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';

const scenarioState = {
  blank: ['空闲', '等待新任务', 0], conversation: ['就绪', '分析用户目标', 12], streaming: ['思考中', '生成架构建议', 24],
  proposal: ['等待确认', '执行提案已生成', 31], permission: ['等待权限', '确认工作区访问范围', 38], running: ['执行中', '分析模块依赖', 63],
  'tool-success': ['执行中', '校验构建产物', 82], 'tool-failed': ['遇到错误', '等待重试命令', 58], cancelled: ['已取消', '任务已停止', 44],
  complete: ['已完成', '准备交付结果', 100], offline: ['未接入', 'Runtime 尚未接入', 0]
} as const;

export function AgentStatusPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const scenario = useMockScenario(services.mock);
  const [state, step, progress] = scenarioState[scenario];
  const tone = scenario === 'complete' ? 'success' : scenario === 'permission' ? 'warning' : scenario === 'tool-failed' || scenario === 'offline' ? 'danger' : scenario === 'running' || scenario === 'streaming' ? 'running' : 'neutral';

  return <section className="agent-status-panel" aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>当前 Agent</span><h1 id={`${moduleId}-title`}>任务状态</h1></div><StatusPill tone={tone}>{state}</StatusPill></header>
    <div className="agent-goal"><span>当前目标</span><p>完成安全、可扩展的 Electron 模块化桌面工作区。</p></div>
    <div className="agent-progress"><div><span>当前步骤</span><strong>{step}</strong></div><span>{progress}%</span><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>
    <div className="status-section"><h2>后续计划</h2><ol><li className="is-done">固定进程安全边界</li><li className="is-current">实现 Chat 与 Dockview 布局</li><li>完成构建和视觉验证</li></ol></div>
    <div className="status-section"><h2>上下文</h2><div className="context-grid"><span><Wrench size={13} /> 5 个工具</span><span><ShieldCheck size={13} /> 工作区权限</span><span><Clock3 size={13} /> 04:36</span></div></div>
    <footer className="agent-controls"><button type="button" onClick={() => services.mock.setScenario('cancelled')}><Square size={13} /> 取消</button><button type="button" onClick={() => services.mock.setScenario('proposal')}><CirclePause size={14} /> 暂停</button></footer>
  </section>;
}
