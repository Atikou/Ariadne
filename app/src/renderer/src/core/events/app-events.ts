import type { UserPreferences } from '@shared/contract';
import type { WorkspaceAccessMode } from '@ariadne/protocol/public';

export interface AgentActivityRecorded {
  id: string;
  kind: 'agent-run' | 'system';
  message: string;
  timestamp: string;
}

export interface AppEventMap {
  'agent:activity-recorded': AgentActivityRecorded;
  'chat:workspace-access-changed': WorkspaceAccessMode;
  'preferences:changed': UserPreferences;
}
