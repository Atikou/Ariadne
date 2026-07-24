import type { TaskType } from "./types.js";

/** 纯问候/致谢等短句，可走 Level 0 规则直答、不调用模型。 */
export function isPureCasualGreeting(text: string): boolean {
  const t = text.trim();
  if (t.length > 16) return false;
  return /^(你好|您好|嗨|hello|hi|在吗|在不在|谢谢|thanks|thank you)[!.?~]*$/i.test(t);
}

/** Level 0 规则直答文案（不调用 LLM）。 */
export function resolveRuleOnlyAnswer(taskType: TaskType, userInput: string): string {
  const t = userInput.trim();
  if (taskType === "casual_chat") {
    if (/^(你好|您好|嗨|hello|hi)[!.?~]*$/i.test(t)) {
      return "你好！我是 Ariadne 助手，有什么可以帮你的？";
    }
    if (/^(在吗|在不在)[!.?~]*$/i.test(t)) {
      return "在的，请说需要我做什么。";
    }
    if (/^(谢谢|thanks|thank you)[!.?~]*$/i.test(t)) {
      return "不客气，有需要随时叫我。";
    }
  }
  return "你好，请描述具体需求，我来帮你处理。";
}
