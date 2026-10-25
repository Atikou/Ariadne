import type { ConversationSession, PublicRunCatalogSummary, PublicDecisionCatalogSummary, RunActivity } from '@ariadne/protocol/public';
import type { ProjectionCatalogWindow } from '../projection/projection-catalog-repository';
import type { RuntimeRun, RuntimePermissionDecision, RuntimePlanDecision, RuntimeUserQuestionDecision } from '../runtime-projection-presenter';
import type { AgentInputDeliveryReceipt } from '../agent-input-delivery';

export type SubagentReference = Pick<RuntimeRun, 'runId' | 'sessionId' | 'parentRunId' | 'subagentMode' | 'origin' | 'aggregateVersion'>
  | Pick<PublicRunCatalogSummary, 'runId' | 'sessionId' | 'parentRunId' | 'subagentMode' | 'version'>;

export interface RunFeatureSnapshot {
  readonly runs: readonly RuntimeRun[];
  readonly activities: readonly RunActivity[];
  readonly agentInputDeliveries: readonly AgentInputDeliveryReceipt[];
  readonly runSummaries: readonly PublicRunCatalogSummary[];
  readonly openedRunId: string | null;
  readonly runDirectory: ProjectionCatalogWindow | null;
  readonly sessionRunDirectory: ProjectionCatalogWindow | null;
}
export interface DecisionFeatureSnapshot {
  readonly openedDecisionId: string | null;
  readonly permissions: readonly RuntimePermissionDecision[];
  readonly planHandoffs: readonly RuntimePlanDecision[];
  readonly userQuestions: readonly RuntimeUserQuestionDecision[];
  readonly decisionSummaries: readonly PublicDecisionCatalogSummary[];
  readonly decisionDirectory: ProjectionCatalogWindow | null;
  readonly sessionDecisionDirectory: ProjectionCatalogWindow | null;
}
export interface SessionFeatureSnapshot {
  readonly sessions: readonly ConversationSession[];
  readonly selectedSessionId: string | null;
  readonly planModeSessionIds: readonly string[];
  readonly sessionDirectory: ProjectionCatalogWindow | null;
}
