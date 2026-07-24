import type { TaskContext } from "../task/TaskContext.js";

export const INTENT_CLASSIFIER_SYSTEM_PROMPT = `你是 Agent 入口意图分类器。只输出一个 JSON 对象，不要 markdown 围栏，不要解释。

字段：
- intent: answer|plan|edit|run|debug|review|verify|summarize|search|refactor|generate_file
- isContinuation: boolean（是否延续当前会话任务）
- isNewTask: boolean（用户是否明确换话题）
- confidence: 0~1

规则：
- 粘贴浏览器报错、终端日志、Vite/npm 输出、工具失败步骤 → 通常 isContinuation=true
- 「继续/开始执行/按计划做」→ isContinuation=true
- 「换个问题/不说这个」→ isNewTask=true
- 纯问答/介绍 → answer
- 只读方案/计划 → plan
- 改代码/写文件 → edit
- 对项目内视觉效果/界面/动画表达不满并要求改进（如「星空有点假，要星云效果」）→ edit，isNewTask=true
- 跑命令/启动服务/验证 → run 或 debug
- 若会话已有 reconciledWorkflowType，续写时优先保持与副作用需求一致
- 禁止输出权限、mode、工具名`;

export interface IntentClassifierPromptContext {
  taskContext?: TaskContext;
  reconciledWorkflowType?: string;
  reconciledIntent?: string;
  completionStatus?: string;
  lastStopReason?: string;
  lastTrustedAnswer?: string;
  toolLedgerSummary?: string;
  capabilityEscalations?: string[];
}

export function buildIntentClassifierUserMessage(input: {
  message: string;
  context?: IntentClassifierPromptContext;
}): string {
  const lines = [`用户消息：\n${input.message.trim()}`];
  const ctx = input.context;
  if (ctx?.taskContext?.isActive) {
    const t = ctx.taskContext;
    lines.push(
      [
        "当前会话任务：",
        `intent=${t.reconciledIntent ?? t.intent}`,
        `workflow=${t.reconciledWorkflowType ?? t.workflowType}`,
        t.entryIntent ? `entryIntent=${t.entryIntent}` : "",
        `phase=${t.currentPhase}`,
        t.goal ? `goal=${t.goal.slice(0, 300)}` : "",
        t.lastFailure ? `lastFailure=${t.lastFailure.slice(0, 200)}` : "",
        t.lastStopReason ? `lastStopReason=${t.lastStopReason}` : "",
        t.lastCompletionStatus ? `completionStatus=${t.lastCompletionStatus}` : "",
        ctx.reconciledWorkflowType ? `reconciledWorkflowType=${ctx.reconciledWorkflowType}` : "",
        ctx.toolLedgerSummary ? `toolLedgerSummary=${ctx.toolLedgerSummary}` : "",
        ctx.lastTrustedAnswer ? `lastTrustedAnswer=${ctx.lastTrustedAnswer.slice(0, 200)}` : "",
        ctx.capabilityEscalations?.length
          ? `capabilityEscalations=${ctx.capabilityEscalations.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else {
    lines.push("当前会话任务：无活跃任务");
  }
  return lines.join("\n\n");
}
