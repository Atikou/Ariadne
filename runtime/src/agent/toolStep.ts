import type { ToolPermission } from "../core/permissions.js";
import type { PermissionConfirmationRequest } from "../policy/PermissionGuard.js";
import type { WorkspaceAccessAudit } from "../policy/PathPolicy.js";
import type { StructuredToolRisk } from "../policy/ToolRiskAssessment.js";
import type { SuggestedToolAction, ToolOutcomeClass } from "../tools/toolOutcome.js";
import type { ToolResultLayers } from "../util/toolResultLayers.js";
import type { RunBudgetKey } from "./RunPolicyTypes.js";

/** 一次工具调用的记录（用于回显执行过程）。 */
export interface AgentToolStep {
  iteration: number;
  toolCallId?: string;
  tool: string;
  input: unknown;
  permission?: ToolPermission;
  thought?: string;
  /** 工具是否已实际执行（blocked / 注册表前置拒绝时为 false）。 */
  executed?: boolean;
  /** observation_success 时为 true */
  ok: boolean;
  outcomeClass?: ToolOutcomeClass;
  outcomeKind?: string;
  outcomeMessage?: string;
  outcomePath?: string;
  outcomeCommand?: string;
  outcomeExitCode?: number;
  suggestedNextActions?: SuggestedToolAction[];
  output?: unknown;
  /** 重复失败保护熔断标记。 */
  recoveryCircuitOpen?: boolean;
  /** 工具结果三层：raw / modelVisible / userDisplay。 */
  resultLayers?: ToolResultLayers;
  error?: string;
  durationMs?: number;
  blocked?: boolean;
  /** 本 run 缓存复用，未真实调用工具 */
  cached?: boolean;
  /** 系统恢复动作（不消耗主 model turn） */
  systemRecovery?: boolean;
  /** 工作流预扫描步骤 */
  preflight?: boolean;
  /** 工作流阶段写入门禁（WorkflowWriteGate），与 WorkflowCapability 只读拦截区分。 */
  workflowPhaseBlocked?: boolean;
  /** 工作流/权限/预算拦截原因分类。 */
  blockedReasonKind?: "workflow" | "permission" | "budget" | "policy";
  budgetExhausted?: RunBudgetKey;
  risk?: StructuredToolRisk;
  confirmationRequest?: PermissionConfirmationRequest;
  /** 多工作区授权沙箱审计信息。 */
  workspaceAccess?: WorkspaceAccessAudit;
  /** 仅由执行编排代码写入；模型输入不能声明验证绑定。 */
  verification?: {
    kind: "write_readback" | "tool_success" | "artifact_check";
    systemAssigned: true;
    verifiesToolCallId?: string;
    criterionIds?: string[];
  };
}
