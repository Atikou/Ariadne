import { z } from "zod";

import { ALL_PERMISSIONS } from "../core/permissions.js";

export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_agent",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ToolPermissionSchema = z.enum(
  ALL_PERMISSIONS as [string, ...string[]],
);

export const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** 子任务目标（可与 title 不同，描述要达成的结果）。 */
  objective: z.string().optional(),
  description: z.string().default(""),
  requiredPermissions: z.array(ToolPermissionSchema).default(["read"]),
  needsConfirmation: z.boolean().default(false),
  /** 验证方式 / 完成判定标准。 */
  acceptance: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  /** 执行本子任务所需的上下文片段说明。 */
  requiredContext: z.array(z.string()).default([]),
  /** 本子任务允许使用的工具名列表。 */
  availableTools: z.array(z.string()).default([]),
  /** 预期产物（文件、报告、命令输出等）。 */
  expectedArtifacts: z.array(z.string()).default([]),
  /** 优先级：数值越小越优先（同层可并行步骤的推荐顺序）。 */
  priority: z.number().int().default(100),
  /** 可选：该步骤绑定的工具名（提供时任务模式会真实执行该工具）。 */
  tool: z.string().optional(),
  /** 可选：传给绑定工具的入参。 */
  toolInput: z.record(z.unknown()).optional(),
  status: StepStatusSchema.default("pending"),
  result: z.string().optional(),
  error: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  goal: z.string(),
  scope: z
    .object({
      inScope: z.array(z.string()).default([]),
      outOfScope: z.array(z.string()).default([]),
    })
    .default({ inScope: [], outOfScope: [] }),
  /** 任务输入（前置条件、素材、环境等）。 */
  inputs: z.array(z.string()).default([]),
  /** 任务输出（交付物、状态变更等）。 */
  outputs: z.array(z.string()).default([]),
  /** 整体验收标准。 */
  acceptanceCriteria: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  steps: z.array(PlanStepSchema).default([]),
});
/**
 * Planner / TaskRunner 边界用的 legacy 计划形状。
 * @deprecated 持久化与执行边界请使用 `plan/types` 的 `ExecutableTaskPlan`（`InternalTaskPlan`）。
 */
export type Plan = z.infer<typeof PlanSchema>;

/**
 * 模型返回的原始计划 schema（较宽松：steps 里允许缺省字段，由我们补全 id/status）。
 */
export const RawPlanSchema = z.object({
  goal: z.string().optional(),
  scope: z
    .object({
      inScope: z.array(z.string()).optional(),
      outOfScope: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
  risks: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string(),
        objective: z.string().optional(),
        description: z.string().optional(),
        requiredPermissions: z.array(ToolPermissionSchema).optional(),
        needsConfirmation: z.boolean().optional(),
        acceptance: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        requiredContext: z.array(z.string()).optional(),
        availableTools: z.array(z.string()).optional(),
        expectedArtifacts: z.array(z.string()).optional(),
        priority: z.number().int().optional(),
        tool: z.string().optional(),
        toolInput: z.record(z.unknown()).optional(),
      }).strict(),
    )
    .optional(),
}).strict();
export type RawPlan = z.infer<typeof RawPlanSchema>;
