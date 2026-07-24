export const AGENT_PROTOCOL_ERROR_CODE = "MODEL_PROTOCOL_ERROR" as const;

/** 模型未满足 AgentAction 协议；该轮响应不得继续、重试或执行工具。 */
export class AgentProtocolError extends Error {
  readonly code = AGENT_PROTOCOL_ERROR_CODE;

  constructor(
    readonly model?: { clientName?: string; modelName?: string },
  ) {
    super("模型返回了无效的 Agent 动作格式，运行已终止，且未执行该响应中的任何工具。");
    this.name = "AgentProtocolError";
  }
}
