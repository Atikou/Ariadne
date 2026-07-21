import { AlertTriangle, Bot, Clock3, Cpu, KeyRound, Radio } from 'lucide-react';
import { MOCK_SCENARIO_LABELS, useMockScenario } from '@renderer/core/mock/mock-scenario';
import type { ModuleServices } from '@renderer/core/modules/module-contract';
import type { SaveStatus } from './Workspace';

export function GlobalStatusBar({ services, saveStatus }: { services: ModuleServices; saveStatus: SaveStatus }): React.JSX.Element {
  const scenario = useMockScenario(services.mock);
  const offline = scenario === 'offline';
  const warningCount = scenario === 'tool-failed' || offline ? 1 : 0;
  return <footer className="global-status-bar"><div><span className={offline ? 'is-danger' : 'is-success'}><Radio size={11} /> {offline ? 'Runtime 未接入' : '本地 Mock'}</span><span><Cpu size={11} /> GPT-5</span><span><Bot size={11} /> {MOCK_SCENARIO_LABELS[scenario]}</span><span><KeyRound size={11} /> {scenario === 'permission' ? '等待授权' : '权限受控'}</span></div><div><span><Clock3 size={11} /> 04:36</span>{warningCount > 0 && <span className="is-warning"><AlertTriangle size={11} /> {warningCount}</span>}<span>{saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '布局保存失败' : '布局已保存'}</span></div></footer>;
}
