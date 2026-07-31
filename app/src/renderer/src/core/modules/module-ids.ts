import { moduleId } from './module-contract';

export const MODULE_IDS = {
  chat: moduleId('chat.main'),
  sessionActivity: moduleId('session.activity'),
  agentStatus: moduleId('agent.status'),
  agentPlan: moduleId('agent.plan'),
  toolOutput: moduleId('tools.output'),
  terminal: moduleId('terminal'),
  logs: moduleId('logs'),
  files: moduleId('files.explorer'),
  permissions: moduleId('permissions'),
  settings: moduleId('settings')
} as const;
