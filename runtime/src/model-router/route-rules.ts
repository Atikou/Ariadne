import type { RouterInput, RuleRouteResult, TaskType } from "./types.js";
import { isPureCasualGreeting } from "./rule-only-responses.js";

const HIGH_RISK_PATTERNS = [
  /删除文件/,
  /批量删除/,
  /批量修改/,
  /覆盖文件/,
  /清空目录/,
  /执行\s*shell/,
  /git\s+reset/,
  /\bformat\b/i,
  /修改系统配置/,
  /键鼠操作/,
];

const ARCHITECTURE_PATTERNS = [
  /架构/,
  /完整方案/,
  /模块设计/,
  /系统设计/,
  /长期方案/,
  /多\s*Agent/,
  /上下文持久化整体设计/,
  /插件系统/,
  /权限系统/,
  /沙箱/,
  /并发编辑/,
  /重构方案/,
];

const DOC_TODO_PATTERNS = [
  /实现文档/,
  /\bTodoList\b/i,
  /待办清单/,
  /实现规范/,
  /长文整理/,
  /Markdown\s*文档/,
];

const DEEP_REVIEW_PATTERNS = [/详细方案/, /完整实现/, /检查漏洞/, /认真审查/];

const MEMORY_WRITE_PATTERNS = [/记住/, /保存记忆/, /记下我/, /默认.*回答/];
const MEMORY_SEARCH_PATTERNS = [/回忆/, /我之前/, /记得我/];

const CODE_PATTERNS = [
  /TypeScript|JavaScript|Python|报错|bug|调试|代码/,
  /解释.*错误/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function isCasualChat(text: string): boolean {
  const t = text.trim();
  if (t.length <= 12 && /^(你好|嗨|hello|hi|在吗|谢谢)/i.test(t)) return true;
  return /闲聊|陪伴|聊天/.test(t);
}

/** 规则路由：关键词 + 质量模式，不调用模型。 */
export class RuleRouter {
  evaluate(input: RouterInput): RuleRouteResult {
    if (input.taskTypeOverride) {
      return this.fromTaskType(input.taskTypeOverride, input, "显式任务类型覆盖");
    }

    const text = input.userInput.trim();

    if (input.qualityMode === "fast") {
      return {
        taskType: isCasualChat(text) ? "casual_chat" : "simple_qa",
        requiredLevel: 1,
        risk: "low",
        reason: "qualityMode=fast，优先低成本单模型",
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (matchesAny(text, HIGH_RISK_PATTERNS) || input.mayModifyWorkspace) {
      return {
        taskType: "high_risk_action",
        requiredLevel: 3,
        risk: "high",
        reason: "高风险操作关键词或可能修改工作区",
        requireUserConfirmation: true,
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (input.hasAttachments && input.attachmentTypes?.includes("image")) {
      return {
        taskType: "image_qa",
        requiredLevel: 3,
        risk: "medium",
        reason: "含图片附件，需 vision 模型",
        requireVision: true,
        requiredCapabilities: ["text", "image"],
        preferredCapabilities: ["ocr"],
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (matchesAny(text, ARCHITECTURE_PATTERNS)) {
      return {
        taskType: "architecture",
        requiredLevel: 3,
        risk: "medium",
        reason: "架构/方案类任务",
        requiredCapabilities: ["text", "code", "architecture"],
        preferredCapabilities: ["jsonMode", "longContext"],
        preferCollaboration: true,
        preferredStrategy: "local_draft_remote_review",
      };
    }

    if (matchesAny(text, DOC_TODO_PATTERNS)) {
      return {
        taskType: "document_qa",
        requiredLevel: input.qualityMode === "deep" ? 3 : 2,
        risk: "medium",
        reason: "文档/TodoList/实现规范类任务",
        preferCollaboration: true,
        preferredStrategy:
          input.qualityMode === "deep" ? "local_draft_remote_review" : "local_draft_remote_review",
      };
    }

    if (matchesAny(text, MEMORY_WRITE_PATTERNS)) {
      return {
        taskType: "memory_write",
        requiredLevel: 1,
        risk: "low",
        reason: "记忆写入意图",
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (matchesAny(text, MEMORY_SEARCH_PATTERNS)) {
      return {
        taskType: "memory_search",
        requiredLevel: 1,
        risk: "low",
        reason: "记忆查询意图",
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (matchesAny(text, CODE_PATTERNS)) {
      const wantCollab = matchesAny(text, DEEP_REVIEW_PATTERNS) || input.qualityMode === "deep";
      return {
        taskType: /报错|bug|调试|错误/.test(text) ? "debug" : "code_question",
        requiredLevel: 2,
        risk: "medium",
        reason: "代码/技术问答",
        preferCollaboration: wantCollab,
        preferredStrategy: wantCollab ? "local_draft_remote_review" : "single_model",
      };
    }

    if (isCasualChat(text)) {
      if (isPureCasualGreeting(text)) {
        return {
          taskType: "casual_chat",
          requiredLevel: 0,
          risk: "low",
          reason: "短问候/致谢，Level 0 规则直答",
          preferredStrategy: "rule_only",
          preferCollaboration: false,
        };
      }
      return {
        taskType: "casual_chat",
        requiredLevel: 1,
        risk: "low",
        reason: "短问候/闲聊",
        preferredStrategy: "single_model",
        preferCollaboration: false,
      };
    }

    if (input.qualityMode === "deep") {
      return {
        taskType: "technical_qa",
        requiredLevel: 2,
        risk: "medium",
        reason: "qualityMode=deep 默认倾向协作",
        preferCollaboration: true,
        preferredStrategy: "local_draft_remote_review",
      };
    }

    return {
      taskType: "unknown",
      requiredLevel: 2,
      risk: "low",
      reason: "默认兜底",
      preferredStrategy: "single_model",
      preferCollaboration: false,
    };
  }

  private fromTaskType(taskType: TaskType, input: RouterInput, reason: string): RuleRouteResult {
    const levelMap: Partial<Record<TaskType, RuleRouteResult["requiredLevel"]>> = {
      casual_chat: 1,
      companion_chat: 1,
      memory_write: 1,
      memory_search: 1,
      summary: 1,
      intent_classification: 1,
      simple_qa: 1,
      technical_qa: 2,
      code_question: 2,
      debug: 2,
      document_qa: 2,
      code_edit: 3,
      architecture: 3,
      image_qa: 3,
      tool_action: 3,
      high_risk_action: 3,
      unknown: 2,
    };
    const requiredLevel = levelMap[taskType] ?? 2;
    const preferCollab =
      input.qualityMode === "deep" &&
      (taskType === "architecture" || taskType === "document_qa" || taskType === "technical_qa");
    return {
      taskType,
      requiredLevel,
      risk: taskType === "high_risk_action" ? "high" : requiredLevel >= 3 ? "medium" : "low",
      reason,
      requireVision: taskType === "image_qa",
      requireUserConfirmation: taskType === "high_risk_action",
      preferCollaboration: preferCollab,
      preferredStrategy: preferCollab ? "local_draft_remote_review" : "single_model",
    };
  }
}
