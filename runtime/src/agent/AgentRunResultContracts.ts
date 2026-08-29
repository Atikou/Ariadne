import type { AgentNotification } from '../notifications/types.js';
import type {
  AgentPromptStrategySummary,
  AgentRouterDecisionSummary,
} from "../model-router/agent-routing-summary.js";
import type {
  AgentPlanContract,
  AgentPlanExecutionReport,
} from "../plan/AgentPlanContract.js";
import type { PlanHandoffPayload } from "../policy/planHandoffTypes.js";
import type { PermissionRequestPayload } from "../policy/permissionRequestTypes.js";
import type { AgentExecutionMeta } from "./AgentExecutionMetaContracts.js";
import type { AgentToolStep } from "./toolStep.js";

export interface AgentRunResult {
  answer: string;
  steps: AgentToolStep[];
  iterations: number;
  reachedLimit: boolean;
  awaitingPermission?: boolean;
  awaitingPlanHandoff?: boolean;
  permissionRequest?: PermissionRequestPayload;
  planHandoff?: PlanHandoffPayload;
  agentPlan?: AgentPlanContract;
  agentPlanExecutionReport?: AgentPlanExecutionReport;
  executionMeta: AgentExecutionMeta;
  routerDecision?: AgentRouterDecisionSummary;
  promptStrategy?: AgentPromptStrategySummary;
  notifications?: AgentNotification[];
  sessionId?: string;
  compressed?: boolean;
}

export interface AgentRunnerPort {
  run(userMessage: string, system?: string): Promise<AgentRunResult>;
}
