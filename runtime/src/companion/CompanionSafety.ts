import {
  CompanionSafetyResultSchema,
  type CompanionSafetyResult,
} from "./CompanionSafetyContracts.js";
import type {
  CompanionOutputMode,
  CompanionOutputModeInput,
} from "./CompanionMemoryContracts.js";

const DEPENDENCY_PATTERNS = [
  /只有我懂你/,
  /你只能依赖我/,
  /别找别人/,
  /找我就够了/,
  /我永远(?:不会)?离开你/,
  /永远陪着你/,
  /你属于我/,
  /我只属于你/,
  /离不开我/,
];

const IDENTITY_PATTERNS = [
  /我是现实(?:中的)?人/,
  /我是你的恋人/,
  /你的恋人/,
  /我是你的男朋友/,
  /我是你的女朋友/,
  /我是你的心理医生/,
  /我有真实(?:身体|生活|经历)/,
];

const TOOL_PROMISE_PATTERNS = [
  /我(?:已经|现在|马上)(?:帮你)?(?:打开|运行|修改|删除|安装|执行)/,
  /我来操作(?:你的)?电脑/,
  /我能控制(?:你的)?(?:浏览器|应用|电脑)/,
];

const REALITY_ANCHOR_PATTERNS = [
  /现实/,
  /身边/,
  /朋友/,
  /家人/,
  /同事/,
  /日常/,
  /作息/,
  /睡/,
  /吃/,
  /走一走/,
  /喝水/,
  /线下/,
  /可信的人/,
  /专业支持/,
];

const WARMTH_PATTERNS = [/听起来/, /我能理解/, /这确实/, /先别急/, /慢慢来/, /我在这里/, /我会陪你/];
const MECHANICAL_PREFIX = /^请注意，本系统无法提供现实陪伴。?/;
const EMOTIONAL_CONTEXT_PATTERNS = [
  /难过/,
  /累/,
  /烦/,
  /崩溃/,
  /孤独/,
  /害怕/,
  /撑不住/,
  /失眠/,
  /焦虑/,
  /痛苦/,
  /没人懂/,
];

export function classifyAttachmentRisk(text: string): "low" | "medium" | "high" | "critical" {
  if (/自杀|不想活|伤害自己|杀了|伤害别人|活不下去/.test(text)) return "critical";
  if (/只有你|离不开你|别让我找别人|我只要你|你属于我|占有/.test(text)) return "high";
  if (/孤独|没人懂我|只想和你说|一直陪我|不要离开/.test(text)) return "medium";
  return "low";
}

export function hasRealityAnchor(text: string): boolean {
  return REALITY_ANCHOR_PATTERNS.some((p) => p.test(text));
}

export function hasWarmth(text: string): boolean {
  return WARMTH_PATTERNS.some((p) => p.test(text));
}

function collectFlags(userText: string, assistantText: string): string[] {
  const joined = `${userText}\n${assistantText}`;
  const flags: string[] = [];
  if (DEPENDENCY_PATTERNS.some((p) => p.test(assistantText))) flags.push("dependency_or_possession");
  if (IDENTITY_PATTERNS.some((p) => p.test(assistantText))) flags.push("virtual_identity_blur");
  if (TOOL_PROMISE_PATTERNS.some((p) => p.test(assistantText))) flags.push("tool_or_control_promise");
  if (classifyAttachmentRisk(joined) !== "low") flags.push("attachment_risk");
  if (!hasRealityAnchor(assistantText)) flags.push("missing_reality_anchor");
  if (!hasWarmth(assistantText)) flags.push("low_warmth");
  return [...new Set(flags)];
}

export function hasCompanionHardBoundaryRisk(input: { userText: string; assistantText: string }): boolean {
  const flags = collectFlags(input.userText, input.assistantText);
  return (
    flags.includes("attachment_risk") ||
    flags.includes("dependency_or_possession") ||
    flags.includes("virtual_identity_blur") ||
    flags.includes("tool_or_control_promise")
  );
}

function removeUnsafeClaims(text: string): string {
  let next = text;
  next = next.replace(MECHANICAL_PREFIX, "我会陪你把话说慢一点。");
  for (const p of [...DEPENDENCY_PATTERNS, ...IDENTITY_PATTERNS, ...TOOL_PROMISE_PATTERNS]) {
    next = next.replace(p, "我会在聊天里认真陪你把这件事理顺");
  }
  return next.trim();
}

function hasEmotionalContext(text: string): boolean {
  return EMOTIONAL_CONTEXT_PATTERNS.some((p) => p.test(text));
}

function boundaryAppendix(risk: "low" | "medium" | "high" | "critical", context: string): string {
  if (risk === "critical") {
    return "我会认真陪你把这句话接住，但这已经需要现实里的支持一起参与了。请先联系身边可信的人，或直接联系当地紧急支持；现在先把自己放到安全一点的地方，慢慢呼吸，别一个人硬扛。";
  }
  if (risk === "high") {
    return "我可以在这里听你说，但不能变成你唯一能抓住的东西。这份难受最好也让现实里一个可信的人知道，哪怕只发一句“我现在有点撑不住”。";
  }
  if (risk === "medium") {
    return "我在这里听你说。先让自己落地一点：喝口水、动一动，或者给现实中相对可信的人发条很短的消息，都可以。";
  }
  if (hasEmotionalContext(context)) {
    return "我会陪你把话说慢一点。可以的话，先做个很小的现实动作：喝口水、站起来走两步，或者给身边的人发句短消息。";
  }
  return "我会把边界说清楚一点：我是在聊天里陪你理顺，不会替代现实里的关系和判断。";
}

export function applyCompanionSafety(input: {
  userText: string;
  assistantText: string;
  outputMode?: CompanionOutputModeInput;
}): CompanionSafetyResult {
  const outputMode = normalizeOutputMode(input.outputMode);
  const risk = classifyAttachmentRisk(`${input.userText}\n${input.assistantText}`);
  if (outputMode === "unrestricted") {
    const content = input.assistantText.trim();
    return CompanionSafetyResultSchema.parse({
      content,
      rewritten: false,
      flags: collectFlags(input.userText, content),
      attachmentRisk: risk,
      realityAnchored: hasRealityAnchor(content),
      virtualIdentitySafe: !IDENTITY_PATTERNS.some((p) => p.test(content)),
      warmEnough: hasWarmth(content),
      outputMode,
    });
  }

  const originalFlags = collectFlags(input.userText, input.assistantText);
  let content = removeUnsafeClaims(input.assistantText);
  let flags = collectFlags(input.userText, content);
  const hasHardBoundaryFlag =
    originalFlags.includes("attachment_risk") ||
    originalFlags.includes("dependency_or_possession") ||
    originalFlags.includes("virtual_identity_blur") ||
    originalFlags.includes("tool_or_control_promise");
  const needsRealityForEmotionalContext =
    outputMode === "bounded" &&
    flags.includes("missing_reality_anchor") &&
    hasEmotionalContext(`${input.userText}\n${content}`);
  const needsBoundary =
    hasHardBoundaryFlag || needsRealityForEmotionalContext;

  if (needsBoundary) {
    content = `${content}\n\n${boundaryAppendix(risk, `${input.userText}\n${content}`)}`.trim();
  }

  flags = collectFlags(input.userText, content);
  if (!needsRealityForEmotionalContext && !hasHardBoundaryFlag) {
    flags = flags.filter((flag) => flag !== "missing_reality_anchor");
  }
  return CompanionSafetyResultSchema.parse({
    content,
    rewritten: content !== input.assistantText,
    flags,
    attachmentRisk: risk,
    realityAnchored: hasRealityAnchor(content),
    virtualIdentitySafe: !IDENTITY_PATTERNS.some((p) => p.test(content)),
    warmEnough: hasWarmth(content),
    outputMode,
  });
}

function normalizeOutputMode(mode?: CompanionOutputModeInput): CompanionOutputMode {
  return mode === "unrestricted" || mode === "raw" ? "unrestricted" : "bounded";
}
