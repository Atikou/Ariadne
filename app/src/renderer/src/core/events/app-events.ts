import type { UserPreferences } from '@shared/contract';

export interface AgentActivityRecorded {
  id: string;
  kind: 'agent-run' | 'system';
  message: string;
  timestamp: string;
}

export interface AppEventMap {
  'agent:activity-recorded': AgentActivityRecorded;
  'preferences:changed': UserPreferences;
}
