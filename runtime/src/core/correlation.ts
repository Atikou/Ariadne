/** 贯穿 trace / 工具 / 编排的统一关联上下文。 */
export interface CorrelationContext {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  triggerId?: string;
  parentRunId?: string;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
