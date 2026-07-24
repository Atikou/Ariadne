import { isAgentStepFailureFeedback, isRuntimeDiagnosticFeedback } from "../agentFailureFeedback.js";

/** 消息侧弱信号：不决定 intent/mode/workflow，仅供延续评分与副作用推断。 */
export interface MessageContinuationSignals {
  charLength: number;
  isShortUtterance: boolean;
  hasAnaphora: boolean;
  lacksNewTaskAnchor: boolean;
  explicitNewTask: boolean;
  explicitReadonlyRequest: boolean;
  isFailurePayload: boolean;
  isRuntimeDiagnostic: boolean;
  /** 提及项目/文件/模块范围（弱信号，不直接映射 intent） */
  referencesProjectScope: boolean;
  /** 对当前效果/产物表达不满（弱信号） */
  expressesOutcomeDissatisfaction: boolean;
  /** 请求改变视觉/行为结果（弱信号） */
  requestsOutcomeChange: boolean;
}

const NEW_TASK_ANCHOR_RE =
  /(什么是|介绍一下|解释一下|帮我审阅|审查一下|代码质量|架构问题|换个问题|新问题|另外问|不说这个|换个话题)/i;

const EXPLICIT_READONLY_RE =
  /(只读|不要改|别改|不要修改|不做修改|只帮我看看|只审查|审阅一下|review only|do not modify|don't modify|without (?:changing|modifying|editing)|no changes)/i;

const EXPLICIT_NEW_TASK_RE = /(换个问题|新问题|另外问|不说这个|换个话题|说点别的|别管刚才|不管上面)/i;

/** 指代/续写弱信号（权重由 TaskContinuationEngine 决定，不映射 mode）。 */
const ANAPHORA_RE = /(再|更|继续|这个|刚才|上面|那样|如此)/;

const PROJECT_SCOPE_RE =
  /(\b[\w.-]+\.(ts|tsx|js|jsx|json|md|html|css|py|go|rs)\b|src\/|docs\/|test\/|模块|文件|项目|\btestTs\b|\btestTS\b)/i;

const OUTCOME_DISSATISFACTION_RE =
  /(有点假|不好看|不像|不够|太简单|太丑|太假|不满意|不对劲|有问题|看起来.{0,6}假|效果.{0,4}差|不够.{0,4}好)/i;

const OUTCOME_CHANGE_RE =
  /(需要|想要|希望|改成|变成|做成|给我|要那种|要是|弄成|换成).{0,12}(效果|感觉|样子|那样|风格|视觉|星空|星云|动画|界面|页面|背景)/i;

export function extractMessageContinuationSignals(message: string): MessageContinuationSignals {
  const text = message.trim();
  const charLength = text.length;
  const isShortUtterance = charLength > 0 && charLength <= 36;
  const hasAnaphora = ANAPHORA_RE.test(text);
  const explicitNewTask = EXPLICIT_NEW_TASK_RE.test(text);
  const explicitReadonlyRequest = EXPLICIT_READONLY_RE.test(text);
  const lacksNewTaskAnchor =
    !explicitNewTask &&
    !NEW_TASK_ANCHOR_RE.test(text) &&
    !/\b[\w.-]+\.(ts|tsx|js|jsx|json|md|html|css|py|go|rs)\b/i.test(text) &&
    !/(src\/|docs\/|test\/|模块|文件)/i.test(text);
  const isFailurePayload = isAgentStepFailureFeedback(text);
  const isRuntimeDiagnostic = isRuntimeDiagnosticFeedback(text);
  const referencesProjectScope = PROJECT_SCOPE_RE.test(text);
  const expressesOutcomeDissatisfaction = OUTCOME_DISSATISFACTION_RE.test(text);
  const requestsOutcomeChange = OUTCOME_CHANGE_RE.test(text);

  return {
    charLength,
    isShortUtterance,
    hasAnaphora,
    lacksNewTaskAnchor,
    explicitNewTask,
    explicitReadonlyRequest,
    isFailurePayload,
    isRuntimeDiagnostic,
    referencesProjectScope,
    expressesOutcomeDissatisfaction,
    requestsOutcomeChange,
  };
}
