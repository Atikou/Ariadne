export interface NetworkPolicyOptions {
  /** 命中任一 deny 正则时拒绝访问（对规范化 hostname 匹配）。 */
  denyDomains?: string[];
  /** 配置后仅允许命中任一 allow 正则的域名；未配置则不启用 allowlist。 */
  allowDomains?: string[];
}

export interface NetworkPolicyDecision {
  hostname: string;
  blocked: boolean;
  reason?: string;
  matchedRule?: string;
  ruleKind?: "deny" | "allow";
}

export interface NetworkPolicy {
  evaluateHostname(hostname: string): NetworkPolicyDecision;
  evaluateTarget(target: string): NetworkPolicyDecision;
  assertAllowed(target: string, messagePrefix?: string): string;
}

type CompiledRule = { source: string; re: RegExp };

export function createNetworkPolicy(options?: NetworkPolicyOptions): NetworkPolicy {
  const deny = compileRules(options?.denyDomains ?? [], "denyDomains");
  const allow = compileRules(options?.allowDomains ?? [], "allowDomains");

  return {
    evaluateHostname(hostname: string): NetworkPolicyDecision {
      const normalized = normalizeHostname(hostname);

      const denyMatch = matchRule(normalized, deny);
      if (denyMatch) {
        return {
          hostname: normalized,
          blocked: true,
          reason: `命中 denyDomains：${denyMatch.source}`,
          matchedRule: denyMatch.source,
          ruleKind: "deny",
        };
      }

      if (allow.length > 0) {
        const allowMatch = matchRule(normalized, allow);
        if (!allowMatch) {
          return {
            hostname: normalized,
            blocked: true,
            reason: "未命中 allowDomains",
          };
        }
        return {
          hostname: normalized,
          blocked: false,
          matchedRule: allowMatch.source,
          ruleKind: "allow",
        };
      }

      return { hostname: normalized, blocked: false };
    },

    evaluateTarget(target: string): NetworkPolicyDecision {
      return this.evaluateHostname(normalizeNetworkTarget(target));
    },

    assertAllowed(target: string, messagePrefix = "网络目标被策略拒绝"): string {
      const decision = this.evaluateTarget(target);
      if (decision.blocked) {
        throw new Error(`${messagePrefix}：${decision.reason ?? decision.hostname}`);
      }
      return decision.hostname;
    },
  };
}

/** 从 URL / host:port / 裸域名解析规范化 hostname（小写、无端口）。 */
export function normalizeNetworkTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("网络目标不能为空");

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) || trimmed.startsWith("//")) {
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    return normalizeHostname(url.hostname);
  }

  const withoutPath = trimmed.split("/")[0] ?? trimmed;
  const hostPart = withoutPath.split("@").pop() ?? withoutPath;
  const hostname = hostPart.split(":")[0] ?? hostPart;
  return normalizeHostname(hostname);
}

export function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes(" ")) {
    throw new Error(`非法 hostname：${hostname}`);
  }
  return normalized;
}

/** 从网络工具入参中提取首个 URL / 域名类字段（供注册表预检与未来工具复用）。 */
export function extractNetworkTarget(input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["url", "endpoint", "host", "hostname", "domain", "baseUrl", "base_url"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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

function matchRule(hostname: string, rules: CompiledRule[]): CompiledRule | undefined {
  return rules.find((rule) => rule.re.test(hostname));
}
