import type { ConversationSession, ModelSummary, RunActivity, PublicRunCatalogSummary, PublicDecisionCatalogSummary, RuntimeStatus, TraceEntry } from '@ariadne/protocol/public';
import type { ProjectionCatalogWindow } from './projection/projection-catalog-repository';
import type { RendererProjectionSnapshot } from './projection/renderer-projection-repository';
import type { RuntimeMessage, RuntimeRun, RuntimePermissionDecision, RuntimePlanDecision, RuntimeUserQuestionDecision } from './runtime-projection-presenter';
import type { AgentInputDeliveryReceipt } from './agent-input-delivery';

export interface RuntimeSnapshot {
  initialized: boolean;
  status: RuntimeStatus;
  projectionStreamId: string | null;
  projectionCursor: number;
  projectionIntegrityError: string | null;
  sessions: ConversationSession[];
  selectedSessionId: string | null;
  planModeSessionIds: string[];
  pendingOverlayIds: string[];
  messages: RuntimeMessage[];
  models: ModelSummary[];
  runs: RuntimeRun[];
  runSummaries: readonly PublicRunCatalogSummary[];
  openedRunId: string | null;
  openedDecisionId: string | null;
  decisionSummaries: readonly PublicDecisionCatalogSummary[];
  projectionWindows: {
    sessions: ProjectionCatalogWindow | null;
    runs: ProjectionCatalogWindow | null;
    decisions: ProjectionCatalogWindow | null;
    sessionRuns: ProjectionCatalogWindow | null;
    sessionDecisions: ProjectionCatalogWindow | null;
    messages: RendererProjectionSnapshot['messageWindow'];
  };
  activities: RunActivity[];
  permissions: RuntimePermissionDecision[];
  planHandoffs: RuntimePlanDecision[];
  userQuestions: RuntimeUserQuestionDecision[];
  trace: TraceEntry[];
  agentInputDeliveries: AgentInputDeliveryReceipt[];
  lastError: string | null;
}

export const STOPPED_STATUS: RuntimeStatus = {
  availability: 'stopped',
  capabilities: [],
  observedAt: new Date(0).toISOString()
};
