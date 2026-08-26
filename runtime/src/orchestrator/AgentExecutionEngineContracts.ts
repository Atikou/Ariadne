import type { AgentRunnerPort } from "../agent/AgentRunResultContracts.js";
import type { AgentExecutionEngineKind } from "./AgentExecutionIdentity.js";
import type { AgentLoopCreationRequest } from "./AgentLoopCreationContracts.js";

export interface AgentExecutionEngine extends AgentRunnerPort {}

export interface AgentExecutionEngineFactory {
  readonly kind: AgentExecutionEngineKind;
  create(request: AgentLoopCreationRequest): AgentExecutionEngine;
}
