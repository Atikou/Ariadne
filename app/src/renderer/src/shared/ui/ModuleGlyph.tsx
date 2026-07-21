import {
  Activity,
  Bot,
  FileCode2,
  ListChecks,
  MessageSquare,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Wrench
} from 'lucide-react';
import type { ModuleIcon } from '@renderer/core/modules/module-contract';

const icons = {
  activity: Activity,
  bot: Bot,
  file: FileCode2,
  list: ListChecks,
  message: MessageSquare,
  settings: Settings,
  shield: ShieldCheck,
  terminal: SquareTerminal,
  tool: Wrench
};

export function ModuleGlyph({ icon, size = 15 }: { icon: ModuleIcon; size?: number }): React.JSX.Element {
  const Icon = icons[icon];
  return <Icon size={size} />;
}
