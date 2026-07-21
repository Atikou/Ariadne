import { Check, Clock3, FolderLock, ShieldCheck } from 'lucide-react';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { StatusPill } from '@renderer/shared/ui/StatusPill';

export function PermissionsPanel({ moduleId }: FeaturePanelProps): React.JSX.Element {
  return <section className="simple-module-panel" aria-labelledby={`${moduleId}-title`}><header className="module-content-header"><div><span>SECURITY</span><h1 id={`${moduleId}-title`}>权限</h1></div><StatusPill tone="success">受控</StatusPill></header><div className="permission-list"><article><span><FolderLock size={16} /></span><div><strong>工作区读取</strong><p>E:\Project\Ariadne · 仅本次任务</p></div><Check size={15} /></article><article><span><ShieldCheck size={16} /></span><div><strong>构建命令</strong><p>npm.cmd run typecheck / build</p></div><Check size={15} /></article><article><span><Clock3 size={16} /></span><div><strong>临时授权</strong><p>任务结束后自动失效</p></div></article></div></section>;
}
