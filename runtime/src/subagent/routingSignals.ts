import { estimateRouterContextTokens } from "../model-router/router-context-estimate.js";
import type { QualityMode, TaskType } from "../model-router/types.js";
import type { DelegatedTaskModelPolicy } from "./delegatedTask.js";

export type TaskComplexity = "low" | "medium" | "high";
export type TaskRiskLevel = "low" | "medium" | "high";

export interface TaskRoutingSignals {
  complexity: TaskComplexity;
  riskLevel: TaskRiskLevel;
  qualityMode: QualityMode;
  contextTokenEstimate: number;
  fileReferenceCount: number;
  taskType: TaskType;
}

export function analyzeTaskRoutingSignals(
  taskText: string,
  extraContext?: string,
  modelPolicy?: Partial<DelegatedTaskModelPolicy>,
): TaskRoutingSignals {
  const text = [taskText.trim(), extraContext?.trim()].filter(Boolean).join("\n");
  const messageTokens = text
    ? estimateRouterContextTokens([{ role: "user", content: text }])
    : 0;
  const fileReferenceCount = countFileReferences(text);

  let complexity: TaskComplexity = "low";
  if (
    messageTokens >= 12_000 ||
    fileReferenceCount >= 4 ||
    /多文件|跨模块|架构|重构|large refactor/i.test(text)
  ) {
    complexity = "high";
  } else if (
    messageTokens >= 4_000 ||
    fileReferenceCount >= 2 ||
    /多个文件|import chain|依赖链/i.test(text)
  ) {
    complexity = "medium";
  }

  const writeIntent = /apply_patch|write_file|补丁|修改文件|patch/i.test(text);
  let riskLevel: TaskRiskLevel = "low";
  if (writeIntent) {
    riskLevel = /删除|覆盖|迁移|数据库|生产|deploy|push/i.test(text) ? "high" : "medium";
  } else if (complexity === "high") {
    riskLevel = "medium";
  }

  let qualityMode: QualityMode =
    modelPolicy?.minQuality === "strong"
      ? "deep"
      : modelPolicy?.minQuality === "fast"
        ? "fast"
        : "balanced";

  if (complexity === "high" || riskLevel === "high") {
    qualityMode = "deep";
  } else if (complexity === "medium" && qualityMode === "fast") {
    qualityMode = "balanced";
  }

  const codeLike =
    fileReferenceCount > 0 ||
    /代码|函数|类|模块|接口|路由|仓库|依赖|编译|构建|TypeScript|JavaScript|Python|code|function|class|module|repo|repository/i.test(
      text,
    );
  let taskType: TaskType = codeLike ? "code_question" : "simple_qa";
  if (writeIntent) {
    taskType = "code_edit";
  } else if (/test|日志|stderr|stack trace|失败|npm run test/i.test(text)) {
    taskType = "debug";
  } else if (/架构|重构|解耦|architecture|refactor/i.test(text)) {
    taskType = codeLike ? "architecture" : "technical_qa";
  } else if (/总结|归纳|summary/i.test(text)) {
    taskType = "summary";
  }

  return {
    complexity,
    riskLevel,
    qualityMode,
    contextTokenEstimate: messageTokens,
    fileReferenceCount,
    taskType,
  };
}

export function countFileReferences(text: string): number {
  const paths = text.match(
    /[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md|yaml|yml|toml|sql|sh|vue|svelte)\b/gi,
  );
  return paths ? new Set(paths.map((p) => p.toLowerCase())).size : 0;
}
