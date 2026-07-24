import {

  buildPendingWorkflowSteps,

  extractCompletedWorkflowSteps,

} from "../orchestrator/runStateTypes.js";

import { BudgetManager, renderBudget } from "./BudgetManager.js";

import { defaultWorkflowPlanner, shouldRunAgentWorkflow } from "./WorkflowPlanner.js";

import type {

  AgentExecutionMeta,

  AgentRunMode,

  LocationExecutionMeta,

  RunBudget,

  RunBudgetKey,

} from "./RunPolicyTypes.js";

import type { AgentToolStep } from "./toolStep.js";

import { isSuccessfulToolStep } from "./toolStepOutcome.js";

import {

  estimateTaskComplexity,

  resolveSuggestedToolCalls,

  type TaskComplexityTier,

} from "./taskComplexity.js";



export interface FinalizerPartialInput {

  steps: AgentToolStep[];

  budgetExhausted: RunBudgetKey;

  budgetManager: BudgetManager;

  mode: AgentRunMode;

  goal: string;

  location?: LocationExecutionMeta;

}



export interface FinalizerProgress {

  completedSteps: string[];

  missingSteps: string[];

  suggestedBudget: RunBudget;

  suggestedToolCalls: number;

  complexityTier: TaskComplexityTier;

}



export interface FinalizerBudgetMeta {

  suggestedBudget: RunBudget;

  suggestedToolCalls: number;

  complexityTier: TaskComplexityTier;

  completedSteps: string[];

  missingSteps: string[];

}



/** 预算耗尽时的部分收尾与执行元数据补强。 */

export class Finalizer {

  buildPartialAnswer(input: FinalizerPartialInput): string {

    const okSteps = input.steps.filter((s) => s.ok);

    const blockedSteps = input.steps.filter((s) => s.blocked);

    const failedSteps = input.steps.filter((s) => !s.ok && !s.blocked && !s.cached);

    const modified = okSteps.filter((s) => s.permission === "write" || s.permission === "dangerous");

    const progress = this.inferProgress(input);

    const ledger = input.budgetManager.ledgerSnapshot();

    const completedHuman = this.describeCompletedSteps(okSteps);

    const missingHuman = this.describeMissing(input, progress.missingSteps, modified.length > 0);



    const lines = [

      "## 运行预算已耗尽",

      "",

      input.budgetManager.formatExhaustedLine(input.budgetExhausted),

      "",

      "### 已完成",

      completedHuman.length ? completedHuman.map((l) => `- ${l}`).join("\n") : "- 尚未成功执行工具调用",

      "",

      "### 未完成",

      missingHuman.map((l) => `- ${l}`).join("\n"),

      "",

      "### 原因",

      `- 预算项：${input.budgetExhausted}`,

      `- 主模型轮次已用尽；预扫描 ${ledger.preflightTools} 次、系统恢复 ${ledger.recoveryTurns} 次、缓存命中 ${ledger.cachedToolHits} 次（分层计数，不全部占用主轮次）`,

    ];



    if (blockedSteps.length) {

      lines.push(

        "",

        "### 被阻塞",

        ...blockedSteps.map(

          (s) => `- ${s.tool}：${s.error ?? "权限或确认限制"}`,

        ),

      );

    }

    if (failedSteps.length) {

      lines.push(

        "",

        "### 失败摘要",

        ...failedSteps.slice(0, 6).map((s) => {

          const kind = s.outcomeKind ?? s.error ?? "unknown";

          return `- ${s.tool}（${kind}）`;

        }),

      );

    }



    const location = input.location;

    if (location) {

      lines.push(

        "",

        "### 定位状态",

        location.locatedFiles.length

          ? `- 已定位：${location.locatedFiles.slice(0, 8).join("、")}`

          : "- 尚未确认 primary 文件",

      );

      if (location.candidateFiles.length) {

        lines.push(`- 候选：${location.candidateFiles.slice(0, 8).join("、")}`);

      }

    }



    lines.push(

      "",

      "### 建议",

      "- 继续本任务（可提高 maxModelTurns / maxReadCalls）",

      "- 或缩小任务范围，减少预扫描与重复读取",

      `- 建议工具调用次数（复杂度 ${progress.complexityTier}）：约 ${progress.suggestedToolCalls} 次`,

      `- 建议继续预算：${renderBudget(progress.suggestedBudget)}`,

    );



    return lines.join("\n");

  }



  /** 多次观察失败 / 熔断后的 partial final 收尾。 */

  buildRecoveryExhaustedAnswer(input: { goal: string; steps: AgentToolStep[] }): string {

    const observations = input.steps.filter((s) => s.outcomeClass === "observation_failure");

    const paths = [

      ...new Set(

        observations

          .map((s) => s.outcomePath ?? (s.input as { path?: string } | undefined)?.path)

          .filter((p): p is string => Boolean(p)),

      ),

    ];

    const kinds = [...new Set(observations.map((s) => s.outcomeKind).filter(Boolean))];

    const lines = [

      "未能完全完成目标，但已收集到以下观察结论：",

      `目标：${input.goal}`,

      "",

      paths.length ? `已检查位置：${paths.map((p) => `- ${p}`).join("\n")}` : "尚未定位到明确路径。",

      kinds.length ? `观察失败类型：${kinds.join("、")}` : "",

      "",

      "当前判断：",

      "- 目标路径可能错误或项目结构不完整",

      "- 已尝试恢复路线，但尚未得到符合预期的结果",

      "",

      "建议：",

      "- 确认项目根目录与目标路径",

      "- 允许创建缺失文件或提供更准确路径",

      "- 或缩小任务范围后重试",

    ];

    return lines.filter(Boolean).join("\n");

  }



  inferProgress(input: FinalizerPartialInput): FinalizerProgress {

    const okSteps = input.steps.filter((s) => s.ok);

    const completedSteps = okSteps.map((s) => `${s.tool}#${s.iteration}`);

    const missingSteps = this.inferMissingSteps(input);

    const budgetMeta = this.buildBudgetMeta(input);

    return {

      completedSteps,

      missingSteps,

      ...budgetMeta,

    };

  }



  buildBudgetExhaustedMeta(input: FinalizerPartialInput): FinalizerBudgetMeta {

    const budgetMeta = this.buildBudgetMeta(input);

    return {

      ...budgetMeta,

      completedSteps: input.steps.filter((s) => s.ok).map((s) => `${s.tool}#${s.iteration}`),

      missingSteps: this.inferMissingSteps(input),

    };

  }



  enrichExecutionMeta(

    base: AgentExecutionMeta,

    input: FinalizerPartialInput,

  ): AgentExecutionMeta {

    if (!base.needsMoreBudget) return base;

    const extra = this.buildBudgetExhaustedMeta(input);

    const suggestedAction = input.location?.needsContinue ? ("continue_locating" as const) : undefined;

    return {

      ...base,

      suggestedBudget: extra.suggestedBudget,

      suggestedToolCalls: extra.suggestedToolCalls,

      complexityTier: extra.complexityTier,

      completedSteps: extra.completedSteps,

      missingSteps: extra.missingSteps,

      suggestedAction,

    };

  }



  private describeCompletedSteps(okSteps: AgentToolStep[]): string[] {

    const lines: string[] = [];

    for (const step of okSteps) {

      if (step.cached) {

        const path = (step.input as { path?: string } | undefined)?.path;

        lines.push(`${step.tool}${path ? ` ${path}` : ""}（缓存复用）`);

        continue;

      }

      const summary = step.resultLayers?.userDisplay.summary ?? step.outcomeMessage;

      if (summary) {

        lines.push(summary);

        continue;

      }

      lines.push(`${step.tool}#${step.iteration}`);

    }

    return lines.slice(0, 12);

  }



  private describeMissing(

    input: FinalizerPartialInput,

    missingSteps: string[],

    hasWrites: boolean,

  ): string[] {

    const lines: string[] = [];

    if (!hasWrites) lines.push("尚未修改文件");

    if (!input.steps.some((s) => s.tool === "shell_run" && isSuccessfulToolStep(s))) {

      lines.push("尚未运行验证命令");

    }

    if (missingSteps.includes("model_final_answer")) {

      lines.push("模型尚未输出 final 结论");

    }

    for (const item of missingSteps) {

      if (item === "model_final_answer" || item === "continue_location") continue;

      lines.push(item);

    }

    return lines;

  }



  private buildBudgetMeta(input: FinalizerPartialInput): Pick<

    FinalizerProgress,

    "suggestedBudget" | "suggestedToolCalls" | "complexityTier"

  > {

    const estimate = estimateTaskComplexity({ goal: input.goal, mode: input.mode });

    const suggested = input.budgetManager.buildSuggestedBudget(input.budgetExhausted);

    const resolved = resolveSuggestedToolCalls({

      goal: input.goal,

      mode: input.mode,

      budgetExhausted: input.budgetExhausted,

      currentBudget: input.budgetManager.budget,

      modeSuggestedToolCalls: input.budgetManager.suggestedBudget.maxToolCalls,

      usedToolCalls: input.steps.filter((s) => !s.cached).length,

    });



    suggested.maxToolCalls = Math.max(suggested.maxToolCalls, resolved.suggestedToolCalls);

    if (input.budgetExhausted === "maxReadCalls") {

      suggested.maxReadCalls = Math.max(suggested.maxReadCalls, estimate.suggestedReadCalls);

    }

    if (input.budgetExhausted === "maxModelTurns") {

      suggested.maxModelTurns = Math.max(suggested.maxModelTurns, estimate.suggestedModelTurns);

    }



    return {

      suggestedBudget: suggested,

      suggestedToolCalls: resolved.suggestedToolCalls,

      complexityTier: resolved.tier,

    };

  }



  private inferMissingSteps(input: FinalizerPartialInput): string[] {

    const missing: string[] = [];

    if (shouldRunAgentWorkflow(input.goal, input.mode)) {

      const workflow = defaultWorkflowPlanner.plan(input.goal, input.mode);

      if (workflow) {

        const completed = extractCompletedWorkflowSteps(input.steps, workflow.steps);

        missing.push(...buildPendingWorkflowSteps(completed, workflow.steps));

      }

    }

    if (input.location?.needsContinue) {

      missing.push("continue_location");

    }

    missing.push("model_final_answer");

    return missing;

  }

}



export const defaultFinalizer = new Finalizer();
