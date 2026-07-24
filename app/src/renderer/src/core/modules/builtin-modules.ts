import { agentPlanModule } from '@renderer/modules/agent-plan';
import { agentStatusModule } from '@renderer/modules/agent-status';
import { chatModule } from '@renderer/modules/chat';
import { fileExplorerModule } from '@renderer/modules/file-explorer';
import { logsModule } from '@renderer/modules/logs';
import { permissionsModule } from '@renderer/modules/permissions';
import { settingsModule } from '@renderer/modules/settings';
import { terminalModule } from '@renderer/modules/terminal';
import { toolOutputModule } from '@renderer/modules/tool-output';
import { ModuleRegistry } from './module-registry';

export const builtinModuleRegistry = new ModuleRegistry([
  chatModule,
  agentStatusModule,
  agentPlanModule,
  toolOutputModule,
  terminalModule,
  logsModule,
  fileExplorerModule,
  permissionsModule,
  settingsModule
]);
