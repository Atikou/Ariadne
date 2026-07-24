import { Bot, FileCode2, MessageSquare, Settings, ShieldCheck, Wrench } from 'lucide-react';
import { MODULE_IDS } from '@renderer/core/modules/module-ids';
import type { ModuleId } from '@renderer/core/modules/module-contract';

interface ActivityBarProps {
  openModuleIds: ReadonlySet<string>;
  onOpen(ids: readonly ModuleId[]): void;
}

const actions = [
  { label: '对话', icon: MessageSquare, ids: [MODULE_IDS.chat] },
  { label: 'Agent', icon: Bot, ids: [MODULE_IDS.agentStatus, MODULE_IDS.agentPlan] },
  { label: '文件', icon: FileCode2, ids: [MODULE_IDS.files] },
  { label: '工具输出', icon: Wrench, ids: [MODULE_IDS.toolOutput] },
  { label: '权限', icon: ShieldCheck, ids: [MODULE_IDS.permissions] }
] as const;

export function ActivityBar({ openModuleIds, onOpen }: ActivityBarProps): React.JSX.Element {
  return (
    <nav className="activity-bar" aria-label="桌面功能栏">
      <div>
        {actions.map(({ label, icon: Icon, ids }) => (
          <button
            key={label}
            type="button"
            className={ids.some((id) => openModuleIds.has(id)) ? 'is-active' : ''}
            data-tooltip={label}
            aria-label={label}
            onClick={() => onOpen(ids)}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className={openModuleIds.has(MODULE_IDS.settings) ? 'is-active' : ''}
        data-tooltip="设置"
        aria-label="设置"
        onClick={() => onOpen([MODULE_IDS.settings])}
      >
        <Settings size={18} />
      </button>
    </nav>
  );
}
