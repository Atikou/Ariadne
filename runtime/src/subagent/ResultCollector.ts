import type { AgentToolStep } from "../agent/toolStep.js";
import type { SubAgentStructuredResult } from "./delegatedTask.js";
import type { SubAgentStatus } from "./types.js";
import type { ModelSelection } from "./types.js";

const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * 从子 Agent 原始输出回收压缩结构化结果，供主 Agent 继续决策。
 */
export class ResultCollector {
  collect(input: {
    taskId: string;
    status: SubAgentStatus;
    rawAnswer: string;
    steps: AgentToolStep[];
    modelUsed?: ModelSelection;
    error?: string;
  }): SubAgentStructuredResult {
    const usedTools = [...new Set(input.steps.map((s) => s.tool).filter(Boolean))] as string[];
    const usedModel = input.modelUsed
      ? `${input.modelUsed.clientName}/${input.modelUsed.model}`
      : undefined;

    if (input.status === "failed" || input.status === "timeout" || input.status === "cancelled") {
      return {
        taskId: input.taskId,
        status: "failed",
        summary: input.rawAnswer || input.error || "子任务执行失败",
        findings: [],
        risks: input.error ? [input.error] : undefined,
        nextActions: ["由主 Agent 决定是否重试或换策略"],
        usedModel,
        usedTools,
        confidence: 0,
      };
    }

    const parsed = tryParseStructured(input.rawAnswer);
    if (parsed) {
      return {
        taskId: input.taskId,
        status: mapRunStatus(parsed.status, input.status),
        summary: String(parsed.summary ?? parsed.answer ?? input.rawAnswer).slice(0, 4_000),
        findings: normalizeStringArray(parsed.findings),
        evidence: normalizeEvidence(parsed.evidence),
        risks: normalizeStringArray(parsed.risks),
        nextActions: normalizeStringArray(parsed.nextActions ?? parsed.next_actions),
        usedModel: typeof parsed.usedModel === "string" ? parsed.usedModel : usedModel,
        usedTools:
          normalizeStringArray(parsed.usedTools ?? parsed.used_tools).length > 0
            ? normalizeStringArray(parsed.usedTools ?? parsed.used_tools)
            : usedTools,
        confidence: clampConfidence(parsed.confidence),
      };
    }

    return this.collectFromProse(input.taskId, input.rawAnswer, usedModel, usedTools);
  }

  private collectFromProse(
    taskId: string,
    answer: string,
    usedModel?: string,
    usedTools?: string[],
  ): SubAgentStructuredResult {
    const findings = extractBulletSection(answer, /发现|findings|问题/i);
    const risks = extractBulletSection(answer, /风险|risks|不确定/i);
    const nextActions = extractBulletSection(answer, /建议|next|下一步/i);

    return {
      taskId,
      status: "success",
      summary: answer.slice(0, 2_000),
      findings,
      risks: risks.length > 0 ? risks : undefined,
      nextActions: nextActions.length > 0 ? nextActions : undefined,
      usedModel,
      usedTools,
      confidence: findings.length > 0 ? 0.7 : 0.5,
    };
  }
}

export const defaultResultCollector = new ResultCollector();

function tryParseStructured(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  const block = trimmed.match(JSON_BLOCK_RE);
  if (block?.[1]) {
    try {
      return JSON.parse(block[1].trim()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mapRunStatus(
  parsedStatus: unknown,
  runStatus: SubAgentStatus,
): SubAgentStructuredResult["status"] {
  if (typeof parsedStatus === "string") {
    if (parsedStatus === "partial") return "partial";
    if (parsedStatus === "failed") return "failed";
    if (parsedStatus === "success") return "success";
  }
  return runStatus === "completed" ? "success" : "partial";
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return [];
}

function normalizeEvidence(
  value: unknown,
): SubAgentStructuredResult["evidence"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => {
      if (typeof item === "string") return { source: "output", detail: item };
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return {
          source: String(o.source ?? "unknown"),
          detail: String(o.detail ?? o.text ?? ""),
        };
      }
      return undefined;
    })
    .filter((x): x is { source: string; detail: string } => Boolean(x?.detail));
  return items.length > 0 ? items : undefined;
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function extractBulletSection(text: string, headingRe: RegExp): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (headingRe.test(line) && /[:：#]/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s/.test(line)) break;
    if (inSection && /^[-*•]\s+/.test(line)) {
      items.push(line.replace(/^[-*•]\s+/, "").trim());
    }
  }
  return items;
}
