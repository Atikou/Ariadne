import type { AgentIntentType } from "./IntentTypes.js";
import { expectedSideEffectsFromRoute } from "./CapabilityEscalation.js";
import { isSoftWorkflow, defaultWorkflowRouter } from "./WorkflowRouter.js";

export interface WorkflowCapabilityHintInput {
  intent: AgentIntentType;
  reconciledWorkflowType?: string;
  reconciledIntent?: AgentIntentType;
}

/** 可执行类工作流的系统提示补充（与 ContextManager 消息组装分离）。 */
export function buildWorkflowCapabilityHint(input: WorkflowCapabilityHintInput): string {
  const route = defaultWorkflowRouter.routeIntent(input.intent);
  if (!isSoftWorkflow(route)) return "";
  const expected = expectedSideEffectsFromRoute(route).join(", ") || "read";
  const lines = [
    "【工作流能力】本任务为可执行类工作流（soft workflow）。",
    `默认预期侧重：${expected}。`,
    "若完成任务必须写入文件或执行命令，可调用相应工具；系统将动态升级任务能力，并由 PermissionGuard 与用户权限策略决定是否执行。",
  ];
  if (input.reconciledWorkflowType && input.reconciledIntent) {
    lines.push(
      `本轮已升级为：${input.reconciledWorkflowType}（${input.reconciledIntent}）。后续步骤与续写将按升级后的工作流理解任务。`,
    );
  }
  return lines.join("\n");
}
