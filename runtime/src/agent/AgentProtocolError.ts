export const AGENT_PROTOCOL_ERROR_CODE = "MODEL_PROTOCOL_ERROR" as const;

/** 模型未满足 AgentAction 协议；该轮响应不得继续、重试或执行工具。 */
export class AgentProtocolError extends Error {
  readonly code = AGENT_PROTOCOL_ERROR_CODE;

  constructor(
    readonly model?: { clientName?: string; modelName?: string },
    readonly category = "unrecoverable_error",
    readonly repairAttempts = 0,
  ) {
    super(
      `模型连续返回无效 Agent 动作，已在 ${repairAttempts} 次无副作用修复后终止；` +
      `错误类别：${category}。该响应中的工具未执行。`,
    );
    this.name = "AgentProtocolError";
  }
}
