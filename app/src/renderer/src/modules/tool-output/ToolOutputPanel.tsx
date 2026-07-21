import { Check, ChevronRight, Clock3, TerminalSquare, Wrench } from 'lucide-react';
import { useMockScenario } from '@renderer/core/mock/mock-scenario';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

export function ToolOutputPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const scenario = useMockScenario(services.mock);
  const failed = scenario === 'tool-failed';
  return <section className="bottom-module-panel" aria-labelledby={`${moduleId}-title`}><header><h1 id={`${moduleId}-title`}>工具输出</h1><span>最近 3 次调用</span></header><div className="tool-call-table"><div className="tool-call-row"><Check size={14} /><Wrench size={14} /><strong>读取项目配置</strong><code>read_file · package.json</code><span><Clock3 size={11} /> 1.8s</span><ChevronRight size={13} /></div><div className={`tool-call-row${failed ? ' is-failed' : ''}`}><TerminalSquare size={14} /><TerminalSquare size={14} /><strong>{failed ? 'PowerShell 执行失败' : '运行类型检查'}</strong><code>{failed ? 'npm.ps1 · PSSecurityException' : 'npm.cmd run typecheck'}</code><span><Clock3 size={11} /> {failed ? '0.2s' : '2.5s'}</span><ChevronRight size={13} /></div></div></section>;
}
