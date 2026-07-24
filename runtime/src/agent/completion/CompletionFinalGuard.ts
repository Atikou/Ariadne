import type { AgentIntentType } from "../IntentTypes.js";
import type { AgentRunMode, AgentStopReason } from "../RunPolicyTypes.js";
import type { AgentToolStep } from "../toolStep.js";
import { augmentContractWithEscalations } from "../capabilityEscalationRuntime.js";
import { evaluateCompletionEvidence } from "./CompletionEvidence.js";
import { buildTaskCompletionContract } from "./TaskCompletionContract.js";
import { buildToolLedger } from "./ToolLedger.js";

export type CompletionStatus =
  | "completed_success"
  | "completed_partial"
  | "awaiting_permission"
  | "blocked_by_policy"
  | "misleading_completion"
  | "historical_reference";

export interface CompletionGuardResult {
  /** @deprecated 使用 trustedForMemory */
  accepted: boolean;
  status: CompletionStatus;
  stopReason: AgentStopReason;
  reason: string;
  contract: ReturnType<typeof buildTaskCompletionContract>;
  ledger: ReturnType<typeof buildToolLedger>;
  evidence: ReturnType<typeof evaluateCompletionEvidence>;
  /** UI 应展示的回答（优先于 rawModelAnswer / result.answer）。 */
  visibleAnswer?: string;
  /** 是否允许作为 AI 主回答展示。 */
  trustedVisible: boolean;
  /** 是否允许进入 ContextRestorer / 已验证记忆。 */
  trustedForMemory: boolean;
  /** 仅 role=system 回灌模型（当前 run 继续时）。 */
  systemFeedback?: string;
  /** Guard 后用户可见、可持久化的可信回答（source=guard）。 */
  guardedAnswer?: string;
  /** 模型原始 final，仅 trace / raw_model_final 持久化。 */
  rawModelAnswer?: string;
}

function blockedRequiredSideEffectSteps(
  steps: AgentToolStep[],
  kind: "shell" | "write",
): AgentToolStep[] {
  return steps.filter((step) => {
    if (!step.blocked) return false;
    if (kind === "shell") return step.tool === "shell_run" || step.permission === "shell";
    return step.tool === "write_file" || step.tool === "apply_patch" || step.permission === "write";
  });
}

/** 构造 Guard 后用户可见的可信 final（messageKind=final_answer, source=guard）。 */
export function buildGuardedFinalAnswer(input: {
  goal: string;
  status: CompletionStatus;
  reason: string;
  ledger: ReturnType<typeof buildToolLedger>;
  blockedSteps: AgentToolStep[];
}): string {
  const shellBlocked = input.blockedSteps.find(
    (s) => s.tool === "shell_run" || s.permission === "shell",
  );
  const writeBlocked = input.blockedSteps.find(
    (s) => s.tool === "write_file" || s.tool === "apply_patch" || s.permission === "write",
  );

  if (input.status === "awaiting_permission" && shellBlocked) {
    const cmd =
      (shellBlocked.input as { command?: string } | undefined)?.command ?? "shell 命令";
    return [
      `依赖尚未安装完成。`,
      `本轮尝试执行：${cmd}`,
      `但 shell 权限未授权，因此命令没有实际运行。`,
      `请在权限弹窗中授权 shell 后继续。`,
    ].join("\n");
  }

  if (input.status === "awaiting_permission" && writeBlocked) {
    const path =
      (writeBlocked.input as { path?: string } | undefined)?.path ??
      writeBlocked.outcomePath ??
      "目标文件";
    return [
      `任务「${input.goal}」尚未完成。`,
      `写入操作（${path}）被权限策略阻止，尚未执行。`,
      `请授权写入权限后继续。`,
    ].join("\n");
  }

  if (input.status === "blocked_by_policy") {
    return [
      `任务「${input.goal}」尚未完成。`,
      input.reason,
      `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次。`,
      `当前工作流或模式不允许所需副作用，请调整策略后重试。`,
    ].join("\n");
  }

  if (input.status === "historical_reference") {
    return [
      `任务「${input.goal}」的历史完成状态尚未在本轮验证。`,
      input.reason,
      `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次。`,
      `请执行必要工具完成副作用，或向用户说明需要重新确认历史状态。`,
    ].join("\n");
  }

  const lines = [
    `任务「${input.goal}」尚未真实完成。`,
    input.reason,
    `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次。`,
  ];
  if (input.status === "misleading_completion") {
    lines.push("模型曾声称任务已完成，但副作用未在 Tool Ledger 中成功执行。");
  }
  lines.push("请授权必要工具或继续执行后再确认完成。");
  return lines.join("\n");
}

/** 构造仅回灌模型的 system 事实（非用户可见回答）。 */
export function buildGuardSystemFeedback(input: {
  goal: string;
  reason: string;
  status: CompletionStatus;
  ledger: ReturnType<typeof buildToolLedger>;
  blockedSteps: AgentToolStep[];
}): string {
  const blockedDesc = input.blockedSteps
    .map((s) => `${s.tool}${s.error ? `: ${s.error}` : ""}`)
    .join("；");
  return [
    "【系统执行事实 · 仅供你修正决策，不是用户消息】",
    `任务：${input.goal}`,
    `completionStatus：${input.status}`,
    `原因：${input.reason}`,
    `Tool Ledger：shell 成功 ${input.ledger.successfulShellCalls} 次 / 写成功 ${input.ledger.successfulWriteCalls} 次`,
    blockedDesc ? `被阻塞工具：${blockedDesc}` : "",
    "请根据以上事实继续：调用必要工具完成副作用，或向用户如实说明尚未完成；禁止在未执行副作用时声称已完成。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 副作用任务 final 真实性校验。
 * 接受时最终回答来自通过完成守卫的模型结果；拒绝时 guardedAnswer 为 UI/历史可验证回答。
 */
export function evaluateCompletionGuard(input: {
  goal: string;
  intent: AgentIntentType;
  mode: AgentRunMode;
  answer: string;
  completionClaim?: "completed" | "partial" | "blocked" | "historical";
  requiredSideEffects?: readonly import("./TaskCompletionContract.js").SideEffectKind[];
  completionCriteria?: readonly import("./TaskCompletionContract.js").CompletionCriterionInput[];
  steps: AgentToolStep[];
  stopReason?: AgentStopReason;
  awaitingPermission?: boolean;
  /** capability escalation 后的有效 intent（用于 completion contract）。 */
  reconciledIntent?: AgentIntentType;
  capabilityEscalations?: import("../CapabilityEscalation.js").CapabilityEscalationRecord[];
}): CompletionGuardResult {
  const effectiveIntent = input.reconciledIntent ?? input.intent;
  const baseContract = buildTaskCompletionContract({
    goal: input.goal,
    intent: effectiveIntent,
    mode: input.mode,
    requiredSideEffects: input.requiredSideEffects,
    completionCriteria: input.completionCriteria,
  });
  const contract = augmentContractWithEscalations(baseContract, input.capabilityEscalations);
  const ledger = buildToolLedger(input.steps);
  const evidence = evaluateCompletionEvidence(contract, input.steps);

  if (input.awaitingPermission || input.stopReason === "awaiting_permission") {
    return withGuardTrust(
      {
        accepted: false,
        status: "awaiting_permission",
        stopReason: "awaiting_permission",
        reason: "等待用户授权必要副作用工具",
        contract,
        ledger,
        evidence,
        guardedAnswer: buildGuardedFinalAnswer({
          goal: input.goal,
          status: "awaiting_permission",
          reason: "等待用户授权必要副作用工具",
          ledger,
          blockedSteps: blockedRequiredSideEffectSteps(input.steps, "shell").concat(
            blockedRequiredSideEffectSteps(input.steps, "write"),
          ),
        }),
      },
      input.answer,
    );
  }

  if (!contract.requiresSideEffect && evidence.satisfied) {
    return withGuardTrust(
      {
        accepted: true,
        status: "completed_success",
        stopReason: input.stopReason ?? "completed",
        reason: "问答/只读任务，无需副作用校验",
        contract,
        ledger,
        evidence,
      },
      input.answer,
    );
  }

  if (evidence.satisfied) {
    return withGuardTrust(
      {
        accepted: true,
        status: "completed_success",
        stopReason: "completed",
        reason: "所需副作用已在 Tool Ledger 中成功执行",
        contract,
        ledger,
        evidence,
      },
      input.answer,
    );
  }

  // 历史状态只能作为未验证引用，不能替代本轮 Tool Ledger 证明。
  if (input.completionClaim === "historical") {
    const guardedAnswer = buildGuardedFinalAnswer({
      goal: input.goal,
      status: "historical_reference",
      reason: "模型引用历史完成状态，但本轮 Tool Ledger 无对应成功副作用，需重新验证或执行",
      ledger,
      blockedSteps: [],
    });
    return withGuardTrust(
      {
        accepted: false,
        status: "historical_reference",
        stopReason: "completed_partial",
        reason: "历史完成声明未通过 Tool Ledger 校验",
        contract,
        ledger,
        evidence,
        rawModelAnswer: input.answer,
        guardedAnswer,
        systemFeedback: buildGuardSystemFeedback({
          goal: input.goal,
          reason: "历史完成声明未通过 Tool Ledger 校验",
          status: "historical_reference",
          ledger,
          blockedSteps: [],
        }),
      },
      input.answer,
    );
  }

  const blockedShell = blockedRequiredSideEffectSteps(input.steps, "shell");
  const blockedWrite = blockedRequiredSideEffectSteps(input.steps, "write");
  const workflowBlocked = [...blockedShell, ...blockedWrite].some(
    (s) => s.blockedReasonKind === "workflow",
  );
  const policyBlocked = [...blockedShell, ...blockedWrite].some(
    (s) => s.blockedReasonKind === "policy" || s.outcomeKind === "policy_blocked",
  );
  const permissionBlocked = [...blockedShell, ...blockedWrite].some(
    (s) =>
      s.blockedReasonKind === "permission" ||
      s.outcomeKind === "permission_denied" ||
      s.outcomeKind === "permission_required",
  );

  let status: CompletionStatus = "completed_partial";
  let stopReason: AgentStopReason = "completed_partial";
  const missingEvidence = evidence.requirements.filter((item) => !item.satisfied);
  const sideEffectEvidenceMet = evidence.requirements
    .filter((item) => item.kind === "side_effect")
    .every((item) => item.satisfied);
  let reason = sideEffectEvidenceMet
    ? `验收证据不完整：${missingEvidence.map((item) => item.reason).join("；")}`
    : "所需副作用未成功执行";

  if (workflowBlocked || policyBlocked) {
    status = "blocked_by_policy";
    stopReason = "blocked_by_policy";
    reason = policyBlocked ? "路径/系统策略不允许所需副作用" : "当前工作流/模式不允许所需副作用";
  } else if (permissionBlocked) {
    status = "awaiting_permission";
    stopReason = "awaiting_permission";
    reason = "必要副作用工具被权限策略阻止，尚未执行";
  } else if ((input.completionClaim ?? "completed") === "completed") {
    status = "misleading_completion";
    stopReason = "misleading_completion";
    reason = sideEffectEvidenceMet
      ? `模型声称本轮任务已完成，但验收证据不完整：${missingEvidence.map((item) => item.reason).join("；")}`
      : "模型声称本轮任务已完成，但 Tool Ledger 无对应成功副作用";
  }

  // 结构化声明为 partial/blocked：如实收尾，但仍不能进入已验证记忆。
  if ((input.completionClaim ?? "completed") !== "completed") {
    if (status === "awaiting_permission") {
      const guardedAnswer = buildGuardedFinalAnswer({
        goal: input.goal,
        status,
        reason,
        ledger,
        blockedSteps: [...blockedShell, ...blockedWrite],
      });
      return withGuardTrust(
        {
          accepted: false,
          status,
          stopReason,
          reason,
          contract,
          ledger,
          evidence,
          guardedAnswer,
          rawModelAnswer: input.answer,
        },
        input.answer,
      );
    }
    const guardedAnswer =
      status === "completed_partial" || status === "blocked_by_policy"
        ? buildGuardedFinalAnswer({
            goal: input.goal,
            status,
            reason,
            ledger,
            blockedSteps: [...blockedShell, ...blockedWrite],
          })
        : undefined;
    return withGuardTrust(
      {
        accepted: false,
        status,
        stopReason,
        reason,
        contract,
        ledger,
        evidence,
        rawModelAnswer: input.answer,
        guardedAnswer,
      },
      input.answer,
    );
  }

  return withGuardTrust(
    {
      accepted: false,
      status,
      stopReason,
      reason,
      contract,
      ledger,
      evidence,
      rawModelAnswer: input.answer,
      guardedAnswer: buildGuardedFinalAnswer({
        goal: input.goal,
        status,
        reason,
        ledger,
        blockedSteps: [...blockedShell, ...blockedWrite],
      }),
      systemFeedback: buildGuardSystemFeedback({
        goal: input.goal,
        reason,
        status,
        ledger,
        blockedSteps: [...blockedShell, ...blockedWrite],
      }),
    },
    input.answer,
  );
}

function withGuardTrust(
  partial: Omit<CompletionGuardResult, "trustedVisible" | "trustedForMemory" | "visibleAnswer">,
  rawAnswer: string,
): CompletionGuardResult {
  const trustedForMemory = partial.status === "completed_success";
  const hideRaw =
    partial.status === "misleading_completion" ||
    partial.status === "awaiting_permission" ||
    partial.status === "blocked_by_policy" ||
    partial.status === "historical_reference";
  const visibleAnswer =
    partial.guardedAnswer ??
    (hideRaw ? partial.guardedAnswer : rawAnswer) ??
    rawAnswer;
  const trustedVisible = Boolean(visibleAnswer?.trim());
  return {
    ...partial,
    accepted: trustedForMemory,
    trustedForMemory,
    trustedVisible,
    visibleAnswer,
  };
}

export function sideEffectsSatisfiedForContract(
  contract: ReturnType<typeof buildTaskCompletionContract>,
  ledger: ReturnType<typeof buildToolLedger>,
): boolean {
  if (!contract.requiresSideEffect) return true;
  if (contract.requiredSideEffects.includes("shell") && ledger.successfulShellCalls === 0) return false;
  if (contract.requiredSideEffects.includes("write") && ledger.successfulWriteCalls === 0) return false;
  return true;
}
