import {
  checkCommandRisk,
  type RiskLevel,
  type RiskVerdict,
} from "../tools/risk.js";

export { checkCommandRisk, type RiskLevel, type RiskVerdict };

export type ShellRiskTier = "low" | "medium" | "high";

export interface ShellPolicyOptions {
  /** 命中任一 deny 正则时拒绝执行。 */
  denyCommands?: string[];
  /** 配置后仅允许命中任一 allow 正则的命令；未配置则不启用 allowlist。 */
  allowCommands?: string[];
}

export interface ShellPolicyDecision {
  verdict: RiskVerdict;
  tier: ShellRiskTier;
  blocked: boolean;
  reason?: string;
  matchedRule?: string;
}

export interface ShellPolicy {
  evaluate(command: string): ShellPolicyDecision;
  assertAllowed(command: string, messagePrefix?: string): RiskVerdict;
}

type CompiledRule = { source: string; re: RegExp };

export function createShellPolicy(options?: ShellPolicyOptions): ShellPolicy {
  const deny = compileRules(options?.denyCommands ?? [], "denyCommands");
  const allow = compileRules(options?.allowCommands ?? [], "allowCommands");

  return {
    evaluate(command: string): ShellPolicyDecision {
      const { tier, verdict, blocked } = classifyShellCommand(command);
      if (blocked) {
        return { tier, verdict, blocked: true, reason: verdict.reason };
      }

      const denyMatch = matchRule(command, deny);
      if (denyMatch) {
        return {
          tier,
          verdict,
          blocked: true,
          reason: `命中 denyCommands：${denyMatch.source}`,
          matchedRule: denyMatch.source,
        };
      }

      if (allow.length > 0) {
        const allowMatch = matchRule(command, allow);
        if (!allowMatch) {
          return {
            tier,
            verdict,
            blocked: true,
            reason: "未命中 allowCommands",
          };
        }
        return { tier, verdict, blocked: false, matchedRule: allowMatch.source };
      }

      return { tier, verdict, blocked: false };
    },
    assertAllowed(command: string, messagePrefix = "命令被策略拒绝"): RiskVerdict {
      const decision = this.evaluate(command);
      if (decision.blocked) {
        throw new Error(`${messagePrefix}：${decision.reason ?? decision.verdict.reason}`);
      }
      return decision.verdict;
    },
  };
}

/** 统一 shell 风险分级（供 shell_run / 后台任务共用）。 */
export function classifyShellCommand(command: string): {
  tier: ShellRiskTier;
  verdict: RiskVerdict;
  blocked: boolean;
} {
  const verdict = checkCommandRisk(command);
  const tier: ShellRiskTier =
    verdict.level === "dangerous" ? "high" : verdict.level === "caution" ? "medium" : "low";
  return { tier, verdict, blocked: tier === "high" };
}

export function assertShellAllowed(command: string): RiskVerdict {
  return createShellPolicy().assertAllowed(command, "高风险命令被拒绝");
}

/** 后台任务用 legacy 文案兼容。 */
export function assertBackgroundCommandAllowed(command: string): RiskVerdict {
  return createShellPolicy().assertAllowed(command, "危险命令被拦截");
}

function compileRules(patterns: string[], fieldName: string): CompiledRule[] {
  return patterns.map((source) => {
    try {
      return { source, re: new RegExp(source, "i") };
    } catch (error) {
      throw new Error(`${fieldName} 包含非法正则「${source}」：${String(error)}`);
    }
  });
}

function matchRule(command: string, rules: CompiledRule[]): CompiledRule | undefined {
  return rules.find((rule) => rule.re.test(command));
}
