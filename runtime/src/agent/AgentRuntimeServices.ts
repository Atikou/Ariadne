import type { DatabaseSync } from "node:sqlite";

import {
  AIIntentClassifier,
  type IntentClassifierChatFn,
} from "./routing/AIIntentClassifier.js";
import { EntryIntentRouter } from "./routing/EntryIntentRouter.js";
import { RunPolicyManager } from "./RunPolicyManager.js";
import { SessionTaskManager } from "./task/SessionTaskManager.js";

export interface AgentRuntimeServices {
  sessionTaskManager: SessionTaskManager;
  aiIntentClassifier: AIIntentClassifier;
  entryIntentRouter: EntryIntentRouter;
  runPolicyManager: RunPolicyManager;
}

export function createAgentRuntimeServices(input: {
  db?: DatabaseSync;
  classifierChatFn?: IntentClassifierChatFn | null;
} = {}): AgentRuntimeServices {
  const sessionTaskManager = new SessionTaskManager(input.db);
  const aiIntentClassifier = new AIIntentClassifier(input.classifierChatFn ?? null);
  const entryIntentRouter = new EntryIntentRouter(sessionTaskManager, aiIntentClassifier);
  const runPolicyManager = new RunPolicyManager(entryIntentRouter);
  return {
    sessionTaskManager,
    aiIntentClassifier,
    entryIntentRouter,
    runPolicyManager,
  };
}
