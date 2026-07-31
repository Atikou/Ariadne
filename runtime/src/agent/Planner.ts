import type { ChatRequest, ModelResponse } from "../model/types.js";
import type { RouteOptions } from "../model/routeOptions.js";
import { requiresConfirmation, type ToolPermission } from "../core/permissions.js";
import { inferAvailableTools } from "./subtaskUtils.js";
import { sortSubtasksByPriority, validateTaskGraph } from "./taskGraph.js";
import { PlanSchema, RawPlanSchema, type Plan } from "./types.js";
import { parseStrictJsonDocument } from "../util/strictJsonDocument.js";

export type ChatFn = (request: ChatRequest, opts?: RouteOptions) => Promise<ModelResponse>;

const PLAN_SYSTEM_PROMPT = `你是一个编码 Agent 的「计划模式」。计划模式只做只读分析，绝不修改文件或执行命令。

请将用户目标解析为结构化任务说明，并自动拆分为可独立推进的子任务（steps）。必须只输出 JSON，不要任何额外文字，结构如下：
{
  "goal": "对目标的清晰复述",
  "scope": { "inScope": ["纳入范围"], "outOfScope": ["明确不做"] },
  "inputs": ["任务输入/前置条件"],
  "outputs": ["任务交付物"],
  "acceptanceCriteria": ["整体验收标准"],
  "risks": ["潜在风险"],
  "dependencies": ["前置依赖"],
  "steps": [
    {
      "id": "step-1",
      "title": "子任务标题",
      "objective": "本子任务要达成的具体目标",
      "description": "做什么、怎么做",
      "dependsOn": ["依赖的 step id，无则 []"],
      "requiredContext": ["执行所需上下文，如文件路径、配置项"],
      "availableTools": ["read_file", "list_files"],
      "expectedArtifacts": ["预期产物，如修改后的文件、测试报告"],
      "acceptance": "验证方式/完成判定",
      "priority": 10,
      "requiredPermissions": ["read" | "write" | "shell" | "network" | "dangerous"],
      "needsConfirmation": true/false
    }
  ]
}

规则：
- 至少拆成 2 个子任务（除非目标极简单且无法合理拆分）；每步粒度应可单独验收。
- priority 越小越优先；无依赖的步骤可并行，priority 用于推荐顺序。
- 涉及修改文件用 write，执行命令用 shell，联网用 network，删除/部署/推送等高风险用 dangerous。
- 凡是 write/shell/network/dangerous 的步骤，needsConfirmation 必须为 true。
- 只读分析步骤用 read，needsConfirmation 为 false。
- availableTools 应与本步权限匹配；只读步骤不要包含 write_file/shell_run。`;

const EXECUTABLE_PLAN_SYSTEM_PROMPT = `${PLAN_SYSTEM_PROMPT}

额外强制要求（可执行编译）：
- 每个 steps[] 项必须包含 "tool" 与 "toolInput"（非空对象），对应注册表中的真实工具名。
- tool 必须从 availableTools 中选择；只读步骤用 read_file/search_text/list_files，写入用 apply_patch/write_file，命令用 shell_run。
- toolInput 必须符合该工具参数 schema；read_file 必须给出 path、startLine、lineCount。
- apply_patch 修改已有文件时，执行 Agent 会先 read_file 获取 expectedSha256；不得用空 search 或伪造补丁。
- 不得猜测 shell 命令、写入内容或补丁内容；信息不足时应先生成只读定位步骤。
- 禁止输出无 tool 的纯说明步骤；每步须可被 TaskExecutor 直接调用。`;

/**
 * 计划模式：调用模型生成结构化计划与子任务拆分。本类不执行任何副作用操作（只读）。
 */
export class Planner {
  constructor(private readonly chat: ChatFn) {}

  async generatePlan(goal: string, context?: string): Promise<Plan> {
    const userContent = context
      ? `目标：${goal}\n\n相关上下文：\n${context}`
      : `目标：${goal}`;

    const response = await this.chat({
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
    });

    return normalizePlan(response.content, goal);
  }

  /** 将骨架计划编译为带 tool + toolInput 的可执行计划（compile / revise 语义编译）。 */
  async generateExecutablePlan(goal: string, context?: string): Promise<Plan> {
    const userContent = context
      ? `目标：${goal}\n\n骨架计划或 Todo 上下文（须绑定可执行 tool）：\n${context}`
      : `目标：${goal}`;

    const response = await this.chat({
      messages: [
        { role: "system", content: EXECUTABLE_PLAN_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
    });

    return normalizePlan(response.content, goal);
  }
}

/** 从模型文本中解析并规范化为合法 Plan（含子任务元数据与拓扑排序）。 */
export function normalizePlan(content: string, fallbackGoal: string): Plan {
  const json = parseStrictJsonDocument(content, "计划模型输出");
  const raw = RawPlanSchema.parse(json);

  const steps = (raw.steps ?? []).map((s, index) => {
    const permissions = (s.requiredPermissions ?? ["read"]) as ToolPermission[];
    const availableTools =
      s.availableTools && s.availableTools.length > 0
        ? s.availableTools
        : inferAvailableTools(permissions);
    return {
      id: s.id ?? `step-${index + 1}`,
      title: s.title,
      objective: s.objective ?? s.description ?? s.title,
      description: s.description ?? "",
      requiredPermissions: permissions,
      needsConfirmation: s.needsConfirmation ?? requiresConfirmation(permissions),
      acceptance: s.acceptance,
      dependsOn: s.dependsOn ?? [],
      requiredContext: s.requiredContext ?? [],
      availableTools,
      expectedArtifacts: s.expectedArtifacts ?? [],
      priority: s.priority ?? (index + 1) * 10,
      tool: s.tool,
      toolInput: s.toolInput,
      status: "pending" as const,
    };
  });

  validateTaskGraph(steps);
  const orderedSteps = sortSubtasksByPriority(steps);

  return PlanSchema.parse({
    goal: raw.goal ?? fallbackGoal,
    scope: {
      inScope: raw.scope?.inScope ?? [],
      outOfScope: raw.scope?.outOfScope ?? [],
    },
    inputs: raw.inputs ?? [],
    outputs: raw.outputs ?? [],
    acceptanceCriteria: raw.acceptanceCriteria ?? [],
    risks: raw.risks ?? [],
    dependencies: raw.dependencies ?? [],
    steps: orderedSteps,
  });
}
