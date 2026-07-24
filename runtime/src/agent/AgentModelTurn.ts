/** Agent 单轮结构化决策摘要；不得包含厂商隐藏推理或未经校验的原始响应。 */
export type AgentModelTurnPhase = "started" | "completed" | "parse_error";

export interface AgentModelTurnEvent {
  iteration: number;
  phase: AgentModelTurnPhase;
  action?: "tool" | "final";
  tool?: string;
  thought?: string;
  contentPreview?: string;
  clientName?: string;
  modelName?: string;
  latencyMs?: number;
}
