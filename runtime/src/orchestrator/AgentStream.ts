import type { AgentRunResult } from "../agent/AgentLoop.js";
import type { AgentModelTurnEvent } from "../agent/AgentModelTurn.js";
import type { AgentToolStep } from "../agent/toolStep.js";
import type { AgentActivityEvent } from "../agent/timeline/types.js";

/** SSE 事件：与 `event:` 字段同名。 */
export type AgentStreamEvent =
  | { type: "run_start"; runId: string; taskId: string; sessionId?: string }
  | { type: "model_turn"; turn: AgentModelTurnEvent }
  | { type: "token"; delta: string; iteration?: number }
  | { type: "step"; step: AgentToolStep }
  | { type: "activity_event"; event: AgentActivityEvent }
  | ({ type: "done" } & AgentRunResult & { runId: string; taskId: string })
  | { type: "error"; error: string; code?: string; runId: string; taskId: string };
