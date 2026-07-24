import { DISPATCH_SUBAGENT_TOOL_NAME } from "../tools/subagentTool.js";
import { wrapUntrustedToolOutput } from "../util/injection.js";
import { clipModelToolJson } from "../util/toolResultLayers.js";
import {
  renderBlockedRecoveryMessage,
  renderExecutionErrorMessage,
  renderToolOutcomeMessage,
} from "./recovery/renderToolOutcome.js";
import {
  renderDispatchSubagentFailure,
  renderSubagentFinalConvergencePrompt,
} from "./SubagentDispatchGuard.js";
import type { AgentToolStep } from "./toolStep.js";

export function renderAgentToolResultObservation(step: AgentToolStep, steps?: AgentToolStep[]): string {
  if (step.blocked) {
    return renderBlockedRecoveryMessage(step);
  }
  if (step.outcomeClass === "observation_failure") {
    const observationText = renderToolOutcomeMessage(step);
    if (observationText) return observationText;
  }
  if (!step.ok) {
    if (step.outcomeClass === "execution_error") {
      return renderExecutionErrorMessage(step);
    }
    if (step.tool === DISPATCH_SUBAGENT_TOOL_NAME) {
      return renderDispatchSubagentFailure(step);
    }
    if (step.error?.startsWith("未知工具：")) {
      return [
        `工具「${step.tool}」执行失败：${step.error}。`,
        "这不是可用工具列表中的工具名；请只从系统提示的可用工具列表选择真实工具。",
        "内部流程名、编排类名或子 Agent 控制器不能作为 tool 字段调用。",
        "如果已经可以回答，请直接输出 final；如果还需要信息，请改用 project_scan、locate_relevant_files、context_pack、read_file 等真实工具。",
      ].join("");
    }
    return `工具「${step.tool}」执行失败：${step.error}。请据此调整下一步。`;
  }
  const compacted = step.resultLayers?.modelVisible ?? step.output;
  const wrapped = wrapUntrustedToolOutput(step.tool, compacted);
  const body = clipModelToolJson(wrapped);
  const base = `工具「${step.tool}」执行结果（JSON）：\n${body}`;
  if (step.tool === DISPATCH_SUBAGENT_TOOL_NAME && steps) {
    return renderSubagentFinalConvergencePrompt(base, steps);
  }
  return base;
}
